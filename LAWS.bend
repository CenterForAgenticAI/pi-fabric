import Base
import ./proofs/kernel.bend as K

# Specification boundary: review changes here independently from implementation.
# Predicates below spell out requirements rather than importing the kernel's
# condition builders. Host observations, validators, hashing, CAS, and compiler
# correctness remain explicit assumptions, not propositions proved here.

def AllTrue(xs: +List<Bool>) -> Type:
  match xs:
    case Nil{}:
      Unit
    case Con{h, t}:
      {h == True{} : Bool} & AllTrue(t)

def SpanAllowed(+boundary: Nat, span: K.Span) -> Bool:
  match span:
    case K.Span{first, last, paired}:
      Bool.not(paired) || Nat.is_le(boundary, first) || Nat.is_lt(last, boundary)

def SpanRequirements(spans: +List<K.Span>, +boundary: Nat) -> +List<Bool>:
  match spans:
    case Nil{}:
      Nil{}
    case Con{h, t}:
      SpanAllowed(boundary, h) <> SpanRequirements(t, boundary)

def CutValid(cut: K.Cut) -> Type:
  match cut:
    case K.Cut{eligible, afterPrevious, retained, budget, boundary, spans}:
      {eligible == True{} : Bool} & ({afterPrevious == True{} : Bool} & ({Nat.is_le(retained, budget) == True{} : Bool} & AllTrue(SpanRequirements(spans, boundary))))

def ChunkRequirements(chunk: K.Chunk) -> +List<Bool>:
  match chunk:
    case K.Chunk{+start, +end, +total, expectedStart, expectedTotal, length, +complete}:
      [Nat.is_eq(start, expectedStart), Nat.is_eq(total, expectedTotal), Nat.is_le(start, end), Nat.is_le(end, total), Nat.is_eq(length, Nat.sub(end, start)), Bool.not(Bool.xor(complete, Nat.is_eq(end, total))), complete || Nat.is_lt(start, end)]

law all_sound:
  for +xs: +List<Bool>
  for p: {K.all(xs) == True{} : Bool}
  AllTrue(xs)

law all_complete:
  for +xs: +List<Bool>
  for p: AllTrue(xs)
  {K.all(xs) == True{} : Bool}

law footprint_sound:
  for +count: Nat
  for +limit: Nat
  for +valid: Bool
  for p: {K.footprintFits(count, limit, valid) == True{} : Bool}
  AllTrue([valid, Nat.is_le(count, limit)])

law unknown_conflict_symmetric:
  for +lu: Bool
  for +luo: Bool
  for +lo: Bool
  for +ru: Bool
  for +ruo: Bool
  for +ro: Bool
  {K.unknownConflict(lu, luo, lo, ru, ruo, ro) == K.unknownConflict(ru, ruo, ro, lu, luo, lo) : Bool}

law transition_sound:
  for +retired: Bool
  for +epoch: Bool
  for +owner: Bool
  for +closed: Bool
  for p: {K.transitionCurrent(retired, epoch, owner, closed) == True{} : Bool}
  AllTrue([Bool.not(retired), epoch, owner, Bool.not(closed)])

law close_sound:
  for +retiring: Bool
  for +owner: Bool
  for +retained: Bool
  for +inflight: Bool
  for p: {K.canClose(retiring, owner, retained, inflight) == True{} : Bool}
  AllTrue([retiring, Bool.not(owner), Bool.not(retained), Bool.not(inflight)])

law cleanup_failure_quarantines:
  for diverted: Bool
  {K.cleanupState(True{}, diverted) == 2 : U32}

law span_sound:
  for +boundary: Nat
  for +span: K.Span
  for p: {K.spanSafe(boundary, span) == True{} : Bool}
  {SpanAllowed(boundary, span) == True{} : Bool}

law spans_sound:
  for +spans: +List<K.Span>
  for +boundary: Nat
  for p: {K.spansSafe(spans, boundary) == True{} : Bool}
  AllTrue(SpanRequirements(spans, boundary))

law cut_sound:
  for +cut: K.Cut
  for p: {K.cutAccepted(cut) == True{} : Bool}
  CutValid(cut)

law pointer_sound:
  for +source: Bool
  for +lineage: Bool
  for p: {K.pointerCurrent(source, lineage) == True{} : Bool}
  AllTrue([source, lineage])

law chunk_sound:
  for +chunk: K.Chunk
  for p: {K.chunkAccepted(chunk) == True{} : Bool}
  AllTrue(ChunkRequirements(chunk))

law coverage_sound:
  for +complete: Bool
  for +truncated: Bool
  for p: {K.coverageComplete(complete, truncated) == True{} : Bool}
  AllTrue([complete, Bool.not(truncated)])

law normalization_sound:
  for +canonical: Bool
  for +plan: Bool
  for +changed: Bool
  for +accepted: Bool
  for p: {K.useNormalized(canonical, plan, changed, accepted) == True{} : Bool}
  AllTrue([Bool.not(canonical), plan, changed, accepted])

law canonical_identity:
  for plan: Bool
  for changed: Bool
  for accepted: Bool
  {K.useNormalized(True{}, plan, changed, accepted) == False{} : Bool}

law pending_without_marker_hidden:
  for sequence: Bool
  for version: Bool
  {K.headReadable(sequence, version, False{}, True{}, False{}) == False{} : Bool}

law committed_head_visible:
  for pending: Bool
  for marker: Bool
  {K.headReadable(True{}, True{}, True{}, pending, marker) == True{} : Bool}

law certificate_sound:
  for +conditions: +List<Bool>
  for p: {K.certificateAccepted(conditions) == True{} : Bool}
  AllTrue(conditions)

law consume_once:
  {K.consume(False{}) == (False{}, False{}) : Bool & Bool}

law consume_retires:
  for active: Bool
  {K.consume(active) == (active, False{}) : Bool & Bool}

law unknown_conflict_exact:
  for +lu: Bool
  for +luo: Bool
  for +lo: Bool
  for +ru: Bool
  for +ruo: Bool
  for +ro: Bool
  {K.unknownConflict(lu, luo, lo, ru, ruo, ro) == ((lu && (luo || ro)) || (ru && (ruo || lo))) : Bool}

law active_lineage_only:
  for member: Bool
  {K.lineageSelected(False{}, member) == member : Bool}

law explicit_all_lineages:
  for member: Bool
  {K.lineageSelected(True{}, member) == True{} : Bool}

law known_conflict_exact:
  for +shared: Bool
  for +left: Bool
  for +right: Bool
  {K.knownConflict(shared, left, right) == (shared && (left || right)) : Bool}

law summary_bounds:
  for +bytes: Nat
  for +byteLimit: Nat
  for +projected: Nat
  for +target: Nat
  for p: {K.summaryWithin(bytes, byteLimit, projected, target) == True{} : Bool}
  AllTrue([Nat.is_le(bytes, byteLimit), Nat.is_le(projected, target)])

law sample_accounting:
  for +total: Nat
  for +retained: Nat
  for +omitted: Nat
  for +limit: Nat
  for p: {K.sampleWithin(total, retained, omitted, limit) == True{} : Bool}
  AllTrue([Nat.is_eq(total, Nat.add(retained, omitted)), Nat.is_le(retained, limit)])

law head_sound:
  for +sequence: Bool
  for +version: Bool
  for +committed: Bool
  for +pending: Bool
  for +marker: Bool
  for p: {K.headReadable(sequence, version, committed, pending, marker) == True{} : Bool}
  AllTrue([sequence, version, committed || (pending && marker)])

# Positive obligations prevent replacing these acceptance decisions with deny-all.
law footprint_complete:
  for +count: Nat
  for +limit: Nat
  for +valid: Bool
  for p: AllTrue([valid, Nat.is_le(count, limit)])
  {K.footprintFits(count, limit, valid) == True{} : Bool}

law transition_complete:
  for +retired: Bool
  for +epoch: Bool
  for +owner: Bool
  for +closed: Bool
  for p: AllTrue([Bool.not(retired), epoch, owner, Bool.not(closed)])
  {K.transitionCurrent(retired, epoch, owner, closed) == True{} : Bool}

law close_complete:
  for +retiring: Bool
  for +owner: Bool
  for +retained: Bool
  for +inflight: Bool
  for p: AllTrue([retiring, Bool.not(owner), Bool.not(retained), Bool.not(inflight)])
  {K.canClose(retiring, owner, retained, inflight) == True{} : Bool}

law normalization_complete:
  for +canonical: Bool
  for +plan: Bool
  for +changed: Bool
  for +accepted: Bool
  for p: AllTrue([Bool.not(canonical), plan, changed, accepted])
  {K.useNormalized(canonical, plan, changed, accepted) == True{} : Bool}

law chunk_complete:
  for +chunk: K.Chunk
  for p: AllTrue(ChunkRequirements(chunk))
  {K.chunkAccepted(chunk) == True{} : Bool}

law certificate_complete:
  for +conditions: +List<Bool>
  for p: AllTrue(conditions)
  {K.certificateAccepted(conditions) == True{} : Bool}
