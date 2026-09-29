/** "Today" / "Yesterday" / "Aug 15" — the same relative-date convention used for recent projects,
 *  wherever they're listed (sidebar, Welcome screen). Falls back to nothing for entries saved before
 *  `lastOpened` existed, rather than guessing. */
export function formatRelativeDate(ts?: number): string {
  if (!ts) return ''
  const day = 24 * 60 * 60 * 1000
  const startOfDay = (t: number): number => new Date(t).setHours(0, 0, 0, 0)
  const diffDays = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / day)
  if (diffDays <= 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return new Date(ts).toLocaleDateString(undefined, { weekday: 'long' })
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
