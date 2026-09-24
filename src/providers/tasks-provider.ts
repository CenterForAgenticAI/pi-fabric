import type { FabricActionDescriptor, FabricInvocationContext, FabricProvider, FabricProviderListRequest } from "../protocol.js";
import type { FabricShellJobStore } from "../core/shell-jobs.js";

const idSchema = { type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"], additionalProperties: false };
const descriptors: FabricActionDescriptor[] = [
  { name: "list", description: "List this session's tracked shell tasks and monitors, with IDs, command, cwd, state, timestamps, and bounded monitor events. No output polling is needed: detached completions notify the owning agent.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "read", effect: { kind: "none", ordering: "commutative" } },
  { name: "get", description: "Inspect one shell task by ID, returning metadata and a bounded output tail. Acknowledges its pending notification after a successful read. Full retained output is at logPath (bounded, not an archive).", inputSchema: idSchema, risk: "read", effect: { kind: "emission", ordering: "ordered" } },
  { name: "stop", description: "Stop one session-owned shell task or monitor by ID using its existing abort controller, not an arbitrary PID. Cancellation does not wake the owning agent.", inputSchema: idSchema, risk: "execute", effect: { kind: "emission", ordering: "ordered" } },
];

export class TasksProvider implements FabricProvider {
  readonly name = "tasks";
  readonly description = "Session-owned background shell tasks and opt-in monitors";
  constructor(readonly jobs: FabricShellJobStore) {}
  async list(request: FabricProviderListRequest): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    return query ? descriptors.filter(d => `${d.name} ${d.description}`.toLowerCase().includes(query)) : descriptors;
  }
  async describe(name: string): Promise<FabricActionDescriptor | undefined> { return descriptors.find(d => d.name === name); }
  async invoke(name: string, args: Record<string, unknown>, _context: FabricInvocationContext): Promise<unknown> {
    if (name === "list") return this.jobs.list();
    if (name !== "get" && name !== "stop") throw new Error(`Unknown tasks action: ${name}`);
    if (typeof args.id !== "string") throw new Error("tasks requires an id");
    const job = this.jobs.get(args.id);
    if (!job) throw new Error(`Unknown shell task: ${args.id}`);
    if (name === "stop") return { stopped: this.jobs.stop(args.id), task: job.info() };
    const before = job.info();
    const output = await job.outputText();
    const after = job.info();
    // A new event during the async read was not necessarily consumed.
    if (before.eventCount === after.eventCount && before.finishedAt === after.finishedAt) this.jobs.acknowledge(args.id);
    return { task: job.info(), output };
  }
}
