import { combineProviderUsage, emptyProviderUsage, type LocalUsageReport, type ProviderUsageSlice } from '../shared/localUsage';

/** Settle providers independently so one unreadable store never blanks the other provider's report. */
export async function combineLocalUsageScans(
  claude: Promise<ProviderUsageSlice>,
  codex: Promise<ProviderUsageSlice>,
): Promise<LocalUsageReport> {
  const [claudeResult, codexResult] = await Promise.allSettled([claude, codex]);
  return combineProviderUsage([
    claudeResult.status === 'fulfilled' ? claudeResult.value : emptyProviderUsage('claude', 'error'),
    codexResult.status === 'fulfilled' ? codexResult.value : emptyProviderUsage('codex', 'error'),
  ]);
}
