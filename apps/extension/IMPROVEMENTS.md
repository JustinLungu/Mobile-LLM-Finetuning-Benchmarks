# Future improvements

Known bugs and improvements for the Wilo extension, not yet done. Line numbers refer to the code as of PR 9 ("Log when the user leaves a watched site") and may drift.

## Bugs to fix

### After a Chrome restart, an old session can wrongly carry on
`background.js`, `samePage` (~line 551), used by `settleOpen`.

When Wilo can't ask a tab (discarded, not loaded yet, or no answer within 2 s), `samePage` returns `null` and `settleOpen` keeps the tab as the same page. Chrome restarts tab ids from low numbers and session restore reopens the same URLs, so a restored, not-yet-loaded tab can share an old id and site.

- Example: a YouTube session in tab 5; the user quits Chrome; Chrome later restores a background YouTube tab that again gets id 5. The session is kept, so:
  - no leave is logged for it;
  - other sites' leaves get `how='unknown'` instead of `browser-closed`;
  - when the tab is finally closed, `untrackTab` logs `leftAt=now` and `endLeft` records a `usedMin` that covers the hours Chrome was closed.
- Fix: keep a tab that couldn't be asked only when the worker started after an extension update or reload (`onInstalled` reason `update`), not after a browser start. Alternatively, treat `tab.status === 'unloaded'` as a new page.

## Improvements

### Ask old tabs in parallel at boot
`background.js`, `settleOpen` (~line 587).

`settleOpen` asks each old tab in turn, waiting up to 2 s per tab that doesn't answer, and `boot()` runs first in the `serial` queue. With 10 hung tabs, boot takes about 20 s, and status check-ins, tab events and handlers wait behind it, so the start screen and time-up UI are late. Ask all tabs at once with `Promise.allSettled`, then process the results.

### Log plan-review entries inside `serial`
`background.js`, `reviewPlan` (~line 211).

`reviewPlan` calls `appendLog` after its `serial` step, while `askWilo` logs inside `serial`. A queued plan-accept or "I'm done" can log its entry first, so the plan-review entry lands after the conversation that already contains its turn. That makes the log confusing as fine-tuning data. Call `appendLog` inside the `serial` callback, as `askWilo` does.

### Report a failed "Delete my conversations"
`popup.js` (~line 218).

The popup ignores the `clear-log` reply and clears the comment box and draft anyway. The handler can reply `{error}` or nothing at all, so the user can think the delete worked, and the next Send uploads conversations they believe they deleted. Check `res.ok` and show an error when it's missing.

### Don't lose saved sessions when boot fails partway
`background.js`, `boot()` (~line 533).

`boot()` marks itself booted in `finally`, so if `settleOpen` throws, `saveOpen({booted:true})` still overwrites `openState` with a partial state. Sessions not yet settled are then never logged as left or ended. Mark booted only after `settleOpen` succeeds, or keep the old `openState` until it is fully settled.

### Show the free-time toast from `catchUp()`
`content.js`, `catchUp()` (~line 884).

When the status call inside `catchUp()` starts a free-time session, the reply includes `freeStart`, but `catchUp` only hides and schedules, so the user gets no toast. Call `freeToast(res.freeStart)` when it's present, as `check()` does.

## Older problems (predate PR 9)

### Check-ins from a page the user isn't on still count
`background.js`, `checkIn` (~line 598).

`checkIn` works out `live` but uses it only for tab tracking. It still refreshes the session's and plan's `lastSeen`, and the status handler can still start a free-time session. Example: inside a free-time window, Chrome prerenders www.youtube.com from the address bar. A free-time `start` is logged, but the tab is never tracked, so no leave is ever logged. When `live` is false, skip the `lastSeen` updates and the free-time start.

### A plan can stay open indefinitely
`background.js`, `checkIn` (~line 596).

The fallback that ends things after too long without a check-in only looks at sessions, so a plan with no `leftAt` is never ended. Example: the user writes a plan, then the computer sleeps or the tab freezes, so no leave fires. On the next visit hours later, the old plan chat comes back instead of a fresh start screen, and its conversation is never logged as left. PR 9 adds `plan.lastSeen`, so apply the same stale-`lastSeen` check to plans.
