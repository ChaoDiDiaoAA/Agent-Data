import type { SelectionConfig, TaskLimitConfig } from '../../types/config.ts';
import type { TaskMode } from '../../types/jobs.ts';
import type { CandidateDecision } from '../../types/papers.ts';

export function taskPaperLimit(config: TaskLimitConfig, mode: TaskMode): number {
  if (mode === 'current') return config.currentTask.maxPapers;
  if (mode === 'weekly') return config.weeklySchedule.maxPapers;
  throw new Error(`unsupported task mode: ${mode}`);
}

const timestamp = (...values: (string | undefined)[]) => Date.parse(values.find((value) => value != null) ?? '0') || 0;
const compareCandidates = (left: CandidateDecision, right: CandidateDecision) =>
  timestamp(right.paper.updatedAt, right.paper.updated, right.paper.submittedAt, right.paper.published)
    - timestamp(left.paper.updatedAt, left.paper.updated, left.paper.submittedAt, left.paper.published)
  || timestamp(right.paper.submittedAt, right.paper.published) - timestamp(left.paper.submittedAt, left.paper.published)
  || String(right.paper.baseId).localeCompare(String(left.paper.baseId));

export function selectTaskDecisions<D extends CandidateDecision>(decisions: D[], config: SelectionConfig, mode: TaskMode, limit = taskPaperLimit(config, mode)) {
  const globalLimit = Math.max(0, Math.trunc(limit));
  const targets = config.currentTask.trackLimits;
  const tracks = Object.keys(targets).filter(track => targets[track] > 0);
  const byId = new Map<string, { item: D; matchedTracks: (string | null | undefined)[]; eligibleTracks: (string | null | undefined)[] }>();
  for (const item of decisions.filter(item => item.accepted === true).sort(compareCandidates)) {
    const id = item.paper.baseId ?? item.paper.arxivId?.replace(/v\d+$/, '');
    if (!id) continue;
    // Automatically eligible labels take precedence over a legacy primary label.
    const matchedTracks = Array.isArray(item.paper.matchedTracks)
      ? item.paper.matchedTracks : [item.primaryTrack];
    const eligibleTracks = Array.isArray(item.paper.eligibleTracks) ? item.paper.eligibleTracks : matchedTracks;
    if (!eligibleTracks.some(track => typeof track === 'string' && tracks.includes(track))) continue;
    const existing = byId.get(id);
    if (existing) {
      existing.matchedTracks = [...new Set([...existing.matchedTracks, ...matchedTracks])].sort();
      existing.eligibleTracks = [...new Set([...existing.eligibleTracks, ...eligibleTracks])].sort();
    } else {
      byId.set(id, { item, matchedTracks: [...new Set(matchedTracks)].sort(), eligibleTracks: [...new Set(eligibleTracks)].sort() });
    }
  }
  const candidates = [...byId.values()];
  const queues = new Map(tracks.map(track => [track, candidates
    .map((candidate, index) => candidate.eligibleTracks.includes(track) ? index : -1)
    .filter(index => index !== -1)]));
  const slots: string[] = [];
  const assigned = new Map<number, number>(); // slot -> candidate
  const owners = new Map<number, number>(); // candidate -> slot

  function assign(slot: number, visited: Set<number>): boolean {
    const queue = queues.get(slots[slot])!;
    // Prefer unused candidates; only move an earlier assignment if necessary.
    const available = queue.find(index => !visited.has(index) && !owners.has(index));
    if (available !== undefined) {
      assigned.set(slot, available);
      owners.set(available, slot);
      return true;
    }
    for (const index of queue) {
      if (visited.has(index)) continue;
      visited.add(index);
      if (assign(owners.get(index)!, visited)) {
        assigned.set(slot, index);
        owners.set(index, slot);
        return true;
      }
    }
    return false;
  }

  // Round-robin priority slots, with reassignment across all matched labels.
  const rounds = Math.max(0, ...tracks.map(track => targets[track]));
  for (let round = 0; round < rounds && assigned.size < globalLimit; round += 1) {
    for (const track of tracks) {
      if (assigned.size >= globalLimit) break;
      if (round >= targets[track]) continue;
      slots.push(track);
      assign(slots.length - 1, new Set());
    }
  }

  const allocate = (index: number, track: string, reason: 'quota' | 'spillover') => ({
    ...candidates[index].item,
    primaryTrack: track,
    selectionReason: reason,
    paper: { ...candidates[index].item.paper, primaryTrack: track, matchedTracks: [...candidates[index].matchedTracks], eligibleTracks: [...candidates[index].eligibleTracks] },
  });
  const selected = [...assigned.entries()].sort(([a], [b]) => a - b)
    .map(([slot, index]) => allocate(index, slots[slot], 'quota'));
  const used = new Map(tracks.map(track => [track, selected.filter(item => item.primaryTrack === track).length]));
  // Empty categories release their capacity, never the inclusion requirements.
  for (let index = 0; index < candidates.length && selected.length < globalLimit; index += 1) {
    if (owners.has(index)) continue;
    const eligible = tracks.filter(track => candidates[index].eligibleTracks.includes(track));
    const track = eligible.sort((a, b) => used.get(a)! / targets[a] - used.get(b)! / targets[b])[0];
    selected.push(allocate(index, track, 'spillover'));
    used.set(track, used.get(track)! + 1);
  }
  return selected;
}
