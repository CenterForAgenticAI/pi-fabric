import { describe, expect, it, vi } from "vitest";
import { BrowserHarnessProvider, type BrowserHarnessSession } from "../src/jev/browser.js";
import { callProgram, jevContext, launch, setupJev } from "./jev-test-helpers.js";
const config = { modulePath: `${process.cwd()}/fixture-session.ts`, wsUrl: "ws://127.0.0.1:9222/devtools/browser/test", allowedMethods: ["Target.getTargets","Target.attachToTarget","Accessibility.getFullAXTree","Runtime.evaluate"] };
function setup() {
  let connected = false;
  const session: BrowserHarnessSession = {
    connect:vi.fn(async()=>{ connected = true; }),isConnected:()=>connected,
    _call:vi.fn(async(method)=>method==="Target.attachToTarget"?{sessionId:"page-1"}:method==="Target.getTargets"?{targetInfos:[{targetId:"target-1"}]}:{nodes:[{role:"button",name:"Download invoice"}]}),
    close:vi.fn(()=>{connected=false;}),
  };
  const loader = vi.fn(async()=>session);
  const browser = new BrowserHarnessProvider(config,loader);
  return { browser,session,loader };
}
describe("Browser Harness component adapter",()=>{
  it("reuses one connection and passes explicit session IDs to allowlisted CDP methods",async()=>{
    const {browser,session,loader}=setup();
    try {
      await browser.invoke("connect",{},jevContext()); await browser.invoke("connect",{},jevContext());
      expect(loader).toHaveBeenCalledTimes(1);
      expect(session.connect).toHaveBeenCalledWith({wsUrl:config.wsUrl,autoAllow:false,timeoutMs:10000});
      await browser.invoke("cdp",{method:"Runtime.evaluate",sessionId:"page-1",params:{expression:"document.title"}},jevContext());
      expect(session._call).toHaveBeenCalledWith("Runtime.evaluate",{expression:"document.title"},{sessionId:"page-1"});
      await expect(browser.invoke("cdp",{method:"Runtime.evaluate"},jevContext())).rejects.toThrow("sessionId");
      await expect(browser.invoke("cdp",{method:"Browser.close"},jevContext())).rejects.toThrow("Invalid");
    } finally { await browser.close(); }
    expect(session.close).toHaveBeenCalledTimes(1);
  });
  it("never auto-connects and closes on unload",async()=>{
    const {browser,session,loader}=setup();
    await expect(browser.invoke("cdp",{method:"Target.getTargets"},jevContext())).rejects.toThrow("connect");
    expect(loader).not.toHaveBeenCalled();
    await browser.invoke("connect",{},jevContext()); await browser.close();
    await expect(browser.invoke("connect",{},jevContext())).rejects.toThrow("closed");
    expect(session.isConnected()).toBe(false);
  });
  it("composes a typed sandboxed program with real provider dispatch",async()=>{
    const {browser}=setup(); const {provider,registry}=setupJev(); registry.register(browser);
    try {
      const run=await callProgram(provider,"run",launch(`await tools.call({ref:"browser.connect"});
        const targets = await tools.call({ref:"browser.cdp",args:{method:"Target.getTargets"}}) as {targetInfos:Array<{targetId:string}>};
        const attached = await tools.call({ref:"browser.cdp",args:{method:"Target.attachToTarget",params:{targetId:targets.targetInfos[0].targetId,flatten:true}}}) as {sessionId:string};
        return await tools.call({ref:"browser.cdp",args:{method:"Accessibility.getFullAXTree",sessionId:attached.sessionId}});`,{requires:["browser.connect","browser.cdp"],outputSchema:{type:"object",required:["nodes"]}}));
      expect(run.state,run.error).toBe("completed"); expect(run.result).toEqual({nodes:[{role:"button",name:"Download invoice"}]});
    } finally {await provider.close();await browser.close();}
  });
  it("closes a connection that completes after caller cancellation",async()=>{
    let finish!:()=>void; let connected=false;
    const session:BrowserHarnessSession={connect:()=>new Promise<void>(resolve=>{finish=()=>{connected=true;resolve();};}),isConnected:()=>connected,_call:async()=>null,close:vi.fn(()=>{connected=false;})};
    const browser=new BrowserHarnessProvider(config,async()=>session);
    const controller=new AbortController();
    const connecting=browser.invoke("connect",{},jevContext(controller.signal));
    await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));
    controller.abort(); await expect(connecting).rejects.toThrow();
    finish(); await vi.waitFor(()=>expect(session.close).toHaveBeenCalled());
    expect(connected).toBe(false); await browser.close();
  });
  it("rejects unsafe or ambiguous connector configuration",()=>{
    expect(()=>new BrowserHarnessProvider({...config,allowedMethods:["*"]})).toThrow("exact");
    expect(()=>new BrowserHarnessProvider({...config,wsUrl:"https://example.com"})).toThrow("ws/wss");
    expect(()=>new BrowserHarnessProvider({...config,modulePath:"relative.ts"})).toThrow("absolute");
  });
});
