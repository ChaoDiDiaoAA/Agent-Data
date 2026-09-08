import type { ResearchWeeklySchedule, WeeklySchedule } from '../../types/config.ts';
import { resolve } from 'node:path';

const windowsDays = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};

/** Backwards-compatible command vector for the standalone FSD scheduler entrypoint. */
export const FSD_WEEKLY_CLI_ARGUMENTS = ['--library', 'fsd', 'run-task', '--mode', 'weekly'] as const;

export function buildScheduleDescriptor(
  config: { weeklySchedule: WeeklySchedule | ResearchWeeklySchedule },
  root: string,
  systemTimezone: string,
  options: { libraryId?: string } = {},
) {
  const schedule = config.weeklySchedule;
  const research = 'maxSources' in schedule;
  return {
    enabled: schedule.enabled,
    taskName: schedule.taskName,
    dayOfWeek: windowsDays[schedule.dayOfWeek],
    intervalWeeks: schedule.intervalWeeks,
    startDate: schedule.startDate,
    startBoundary: `${schedule.startDate}T${schedule.localTime}:00`,
    localTime: schedule.localTime,
    timezone: schedule.timezone,
    systemTimezone,
    timezoneMatches: systemTimezone === schedule.timezone,
    ...(research ? { maxSources: schedule.maxSources } : { maxPapers: schedule.maxPapers }),
    entrypoint: resolve(root, 'automation', 'weekly', 'run-weekly-task.ts'),
    command: ['--library', options.libraryId ?? 'fsd', 'run-task', '--mode', 'weekly'],
  };
}
