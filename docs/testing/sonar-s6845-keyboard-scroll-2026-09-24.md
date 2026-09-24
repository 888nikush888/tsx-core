# Sonar S6845: keyboard-scrollable review table

On 2026-09-24, Sonar issue `AaCvLFJNFuOCeZdBf0eg` on `main` revision
`58c01bc74f83cc212849ddcd7e487412ff06b2b7` was individually marked
False Positive with an explanatory issue comment. It identifies
`frontend/src/shared/components/change-review.tsx:32`, where a named
`overflow-x-auto` table section has `tabIndex={0}`.

The section intentionally accepts keyboard focus so users can scroll wide
table content. `frontend/tests/sonar-ui-semantics.test.tsx` checks its named
region and focus behavior. The four browser/accessibility profiles passed on
PR #79 at `36c34d08994024fddd2916947dc1952fc2530fc5`; this file is
unchanged between that commit and the cited `main` revision.

The [W3C ACT keyboard-scroll rule](https://www.w3.org/WAI/standards-guidelines/act/rules/0ssw9k/)
lists a scrollable `section` with `tabindex="0"` as Passed Example 1 and a
scrollable section without keyboard-reachable content as a failed example.
Removing `tabIndex` here would risk making horizontally overflowed content
unreachable from the keyboard. This decision applies only to the cited
occurrence, not to S6845 globally.
