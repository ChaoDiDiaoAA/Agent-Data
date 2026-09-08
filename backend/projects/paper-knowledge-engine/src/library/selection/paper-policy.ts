import type { PaperMetadata } from '../../types/papers.ts';
import type { PaperPolicy } from '../../types/config.ts';
const asArray = <T>(value: T[] | null | undefined): T[] => Array.isArray(value) ? value : [];
const normalized = (value: unknown) => String(value ?? '').trim().toLowerCase();
const uniqueSorted = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
const sortedTracks = (values: string[] | undefined) => asArray(values).map(String).sort((a, b) => a.localeCompare(b));
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lexicalText = (value: unknown) => normalized(value).normalize('NFKC').replace(/[\s\p{Pd}]+/gu, ' ');
const matches = (text: string, terms: string[] | undefined, variants: Record<string, string[]> = {}) => {
  const searchable = lexicalText(text);
  return uniqueSorted(asArray(terms)
    .map(normalized)
    .filter(Boolean)
    .filter(term => [term, ...asArray(variants[term])].some(form =>
      new RegExp(`(?:^|[^a-z0-9])${escaped(lexicalText(form))}(?=$|[^a-z0-9])`, 'i').test(searchable))));
};

export function assertTrackReachability({ plan, rules, trackLimits, categories }: { plan: { tracks: string[] }; rules: Pick<PaperPolicy, "trackPriority">; trackLimits: Record<string, number>; categories: { tracks: Record<string, unknown> } }) {
  const planTracks = sortedTracks(plan?.tracks);
  const policyTracks = sortedTracks(rules?.trackPriority);
  const quotaTracks = Object.keys(trackLimits ?? {}).sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(planTracks) !== JSON.stringify(policyTracks)
    || JSON.stringify(planTracks) !== JSON.stringify(quotaTracks)) {
    throw new Error('plan, policy priority, and quota tracks must exactly match');
  }
  const categoryTracks = categories?.tracks ?? {};
  const missingCategories = planTracks.filter((track) => !Object.hasOwn(categoryTracks, track));
  if (missingCategories.length) {
    throw new Error(`categories must contain every active track: ${missingCategories.join(', ')}`);
  }
}

export function annotatePaper<P extends PaperMetadata>(paper: P, rules: Partial<PaperPolicy> = {}) {
  const title = String(paper.title ?? '');
  const summary = String(paper.summary ?? '');
  // Inclusion evidence comes from source text, never caller-supplied labels.
  const normalizedText = normalized(`${title}\n${summary}`);
  const published = String(paper.published ?? paper.submittedAt ?? '');
  const updated = String(paper.updated ?? paper.updatedAt ?? published);
  const submittedAt = String(paper.submittedAt ?? published.slice(0, 10));
  const updatedAt = String(paper.updatedAt ?? updated.slice(0, 10));
  const hasImportant2026Version = paper.hasImportant2026Version ?? (published.slice(0, 4) < '2026' && updated.slice(0, 4) >= '2026');
  return {
    ...paper,
    published,
    updated,
    submittedAt,
    updatedAt,
    hasImportant2026Version,
    aiTechniques: matches(normalizedText, rules.aiTechniqueTerms, rules.termVariants),
    programStructures: matches(normalizedText, rules.programStructureTerms, rules.termVariants),
    engineeringTasks: matches(normalizedText, rules.engineeringTaskTerms, rules.termVariants),
    normalizedText,
  };
}

export function evaluateCandidate<P extends PaperMetadata>(rawPaper: P, rules: Partial<PaperPolicy> = {}) {
  const paper = annotatePaper(rawPaper, rules);
  const sourceVersion = String(paper.arxivId ?? '').match(/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})v([1-9]\d*)$/);
  const sourceAccepted = sourceVersion !== null
    && paper.arxivId!.replace(/v\d+$/, '') === paper.baseId
    && Number(sourceVersion[1]) === Number(paper.version ?? 1);
  const sourceTime = (value: string) => {
    const day = String(value ?? '').slice(0, 10);
    const dayTime = Date.parse(`${day}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(String(value)) || !Number.isFinite(dayTime)
      || new Date(dayTime).toISOString().slice(0, 10) !== day) return NaN;
    return Date.parse(value);
  };
  const submittedTime = sourceTime(paper.published);
  const updatedTime = sourceTime(paper.updated);
  const startTime = sourceTime(rules.startDate ?? '2026-01-01');
  const dateAccepted = Number.isFinite(submittedTime) && Number.isFinite(updatedTime)
    && (submittedTime >= startTime || (updatedTime >= startTime && updatedTime > submittedTime));
  const signals = { technologyMatched: paper.aiTechniques.length > 0 || paper.programStructures.length > 0,
    taskMatched: paper.engineeringTasks.length > 0,
    lane: paper.aiTechniques.length ? 'ai' : paper.programStructures.length ? 'program-analysis' : null };
  const excludedTerms = asArray(rules.excludedDomains).map(lexicalText).filter(Boolean);
  const searchable = lexicalText(`${paper.title ?? ''}\n${paper.summary ?? ''}`);
  const excluded = excludedTerms.some((value) => searchable.includes(value));
  const priority = asArray(rules.trackPriority);
  const candidateTracks = priority.filter(track => asArray(paper.matchedTracks).includes(track));
  const technologyAccepted = signals.technologyMatched;
  const taskAccepted = signals.taskMatched;
  const trackAccepted = candidateTracks.length > 0;
  const accepted = sourceAccepted && dateAccepted && !excluded
    && technologyAccepted && taskAccepted && trackAccepted;
  const status = accepted ? 'accepted' : 'rejected';
  const eligibleTracks = accepted ? candidateTracks : [];
  const lane = accepted ? signals.lane : null;
  const primaryTrack = priority.find(track => eligibleTracks.includes(track)) ?? null;
  return { accepted, status, lane, primaryTrack, signals,
    reasons: { sourceAccepted, dateAccepted, excluded, technologyAccepted, taskAccepted, trackAccepted },
    paper: { ...paper, eligibleTracks } };
}
