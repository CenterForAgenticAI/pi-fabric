import { afterAll, describe, expect, it } from "vitest";
import { JevCredentials } from "../src/jev/client.js";
import { setupJev, callProgram, launch } from "./jev-test-helpers.js";

// Explicit opt-in only. This suite never prints credentials or raw transport errors.
const enabled = process.env.PI_FABRIC_JEV_LIVE === "1";
const command = process.env.PI_FABRIC_JEV_LOCALTERM === "1" ? ["localterm","secret","get","typesafe_api_key"] : [];
describe.skipIf(!enabled)("live Jev System One", () => {
  const credentials = new JevCredentials(command);
  const { provider, client, registry } = setupJev({jev:{credentialCommand:command,requestTimeoutMs:30_000}}, undefined, credentials);
  afterAll(async () => { await provider.close(); });
  it("returns Choice, Noul, and Score in one real request", async () => {
    const start = performance.now();
    const result = await client.evaluate({state:{message:"Please refund the duplicate charge on my invoice."},questions:{
      route:{type:"choice",instructions:"Which team handles the customer's request in `message`?",criteria:{billing:"Invoices, charges, refunds",technical:"Broken software",other:"No matching team"}},
      refund:{type:"noul",instructions:"Does `message` explicitly request a refund?"},
      urgency:{type:"score",instructions:"How time-sensitive is the request in `message`?",criteria:["No urgency or deadline stated","A future deadline is stated","Immediate action is explicitly requested"]},
    }},new AbortController().signal);
    expect(result.answers.route?.type).toBe("choice");
    expect(result.answers.route && "choice" in result.answers.route && result.answers.route.choice).toBe("billing");
    expect(result.answers.refund && "noul" in result.answers.refund && result.answers.refund.noul).toBeGreaterThan(0.5);
    console.log(JSON.stringify({probe:"batched-primitives",model:result.model,elapsedMs:Math.round(performance.now()-start),usage:result.usage}));
  },45_000);
  it("drives a feedback controller using fresh observations and source control IDs", async () => {
    let step = 0;
    const screens = [
      {text:"Account overview. Choose a section.",controls:[{id:"settings",label:"Account preferences"},{id:"billing",label:"Billing and invoices"}]},
      {text:"Invoices. Most recent invoice is September 2026.",controls:[{id:"download",label:"Download latest invoice PDF"},{id:"help",label:"Get help with billing"}]},
      {text:"Latest invoice PDF download finished successfully.",controls:[]},
    ];
    const descriptors = [
      {name:"observe",description:"Observe a synthetic browser screen",inputSchema:{type:"object",properties:{},additionalProperties:false},risk:"read" as const},
      {name:"act",description:"Apply a synthetic control",inputSchema:{type:"object",properties:{id:{type:"string"},revision:{type:"integer"}},required:["id","revision"],additionalProperties:false},risk:"execute" as const},
    ];
    registry.register({name:"fixture",description:"Synthetic browser feedback fixture",list:async()=>descriptors,describe:async name=>descriptors.find(d=>d.name===name),invoke:async(name,args)=>{
      if(name==="observe") return {...screens[step],revision:step};
      if(args.revision!==step || args.id!==["billing","download"][step]) throw new Error("Incorrect or stale synthetic browser action");
      step++; return {applied:true};
    }});
    const run=await callProgram(provider,"run",launch(`const latencies = [];
      for(let tick=0;tick<3;tick++) {
        const screen = await tools.call({ref:"fixture.observe"}) as {text:string;revision:number;controls:Array<{id:string;label:string}>};
        const criteria:Record<string,string> = {done:"The latest invoice PDF has already finished downloading",none:"No available control advances the goal"};
        for(const control of screen.controls) criteria[control.id]=control.label;
        const start=Date.now();
        const r=await jev.evaluate({state:{goal:"Download the latest invoice PDF",screen},questions:{
          next:{type:"choice",instructions:"Which control in screen.controls advances goal? Choose done only if screen confirms the goal is complete, or none if no control fits.",criteria}
        }});
        latencies.push(Date.now()-start);
        if(r.answers.next.choice==="done") return {completed:true,latencies};
        if(r.answers.next.choice==="none") throw new Error("No applicable action");
        await tools.call({ref:"fixture.act",args:{id:r.answers.next.choice,revision:screen.revision}});
      }
      return {completed:false,latencies};`,{requires:["jev.evaluate","fixture.observe","fixture.act"],limits:{maxEvaluations:3,maxTokens:10_000,timeoutMs:90_000}}));
    expect(run.state,run.error).toBe("completed");
    expect(run.result).toMatchObject({completed:true}); expect(step).toBe(2);
    console.log(JSON.stringify({probe:"feedback-controller",result:run.result,usage:run.usage}));
  },100_000);
  const program = launch(`const routed = [];
    for (const ticket of input.tickets) {
      const r = await jev.evaluate({ state: ticket, questions: {
        route: {type:"choice", instructions:"Which team should handle the request in this ticket's text?", criteria:{billing:"Invoices, charges, refunds",technical:"Software errors and broken features",other:"No matching team"}}
      }});
      routed.push({id:ticket.id,team:r.answers.route.choice});
      await program.emit({id:ticket.id,team:r.answers.route.choice});
      await program.sleep(10);
    }
    return routed;`,{
    requires:["jev.evaluate"],limits:{maxEvaluations:2,maxTokens:10_000,timeoutMs:90_000},
    inputSchema:{type:"object",required:["tickets"],properties:{tickets:{type:"array",items:{type:"object",required:["id","text"],properties:{id:{type:"string"},text:{type:"string"}},additionalProperties:false}}},additionalProperties:false},
    outputSchema:{type:"array",items:{type:"object",required:["id","team"],properties:{id:{type:"string"},team:{enum:["billing","technical","other"]}},additionalProperties:false}},
  },{tickets:[{id:"a",text:"I was billed twice; please refund one charge."},{id:"b",text:"The application crashes every time I open settings."}]});
  for (const method of ["run","spawn"] as const) it(`executes the real typed inference loop through ${method}`,async()=>{
    const start = performance.now();
    const initial = await callProgram(provider,method,program);
    const result = method==="spawn" ? await provider.manager.join(initial.id) : initial;
    expect(result.state, result.error).toBe("completed");
    expect(result.result).toEqual([{id:"a",team:"billing"},{id:"b",team:"technical"}]);
    expect(result.evaluations).toBe(2);
    console.log(JSON.stringify({probe:method,elapsedMs:Math.round(performance.now()-start),evaluations:result.evaluations,usage:result.usage}));
  },100_000);
});
