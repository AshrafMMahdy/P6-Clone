// The window's heap, shared with the child process that answers its screens (main/analysis-export-ipc.ts): a project the window
// holds is not refused there for want of memory (item 26, desktop C3).
// AGREED LIMIT (owner, 2026-11-28): 12 GB — the window's heap and the screens' child's heap and memory budget; past it the window stops and says so ("The window stopped …") — why: item 26 rule 5, "Timers, memory, and safety - agreed" — necessary to raise V8's default; 12 GB arbitrary by agreement.
export const WINDOW_HEAP_MB = 12288;
