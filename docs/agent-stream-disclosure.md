# Agent stream disclosures

Expanding or collapsing something in the chat timeline (a turn's summary line, a tool-call group,
a tool call's inline details, a todo card, a long user message's show more, a plan card) keeps the
tapped trigger at the same screen y in the first painted frame. No animation.

## The contract

A disclosure component knows nothing about the list. It wraps its state change:

```tsx
const hold = useDisclosureHold();
const handleToggle = () => hold(() => setExpanded((value) => !value));
```

`view.tsx` wraps every timeline row in `DisclosureRow`, which routes `hold` to the strategy's
`holdRow(rowId, apply, triggerEdge)` (`packages/app/src/agent-stream/disclosure.tsx`). Outside a
timeline row, `apply` runs as is. The strategy owns when `apply` runs and how the row keeps its place.
A toggle that calls `setState` directly skips the hold: on Android the expanded content paints
over the next row for a frame before the list learns the new size.

`triggerEdge` names the edge of the row the trigger sits on, and the strategy keeps that edge in
place. Header triggers sit on the top edge, the default. A long user message's show more sits under
the text it opens, so `MessagePreview` passes `{ triggerEdge: "bottom" }`: the text grows and shrinks
above the trigger, and the rows below stay put.

### Following output

Generation preserves the reading position, including when the viewport rests exactly at the end.
Entry/reload, Send (including running Send and Queue track Send now), rewind, and **Scroll to bottom**
request one end landing. Automatic queued dispatch and remote messages do not request navigation.
After the first measurable write, two consecutive painted frames within 1 logical px of the end
release the landing, with a hard limit of 60 eligible frames. Hidden or unmeasurable frames do not
consume that budget. User intent cancels even a request waiting for history. An expired request
cannot restart from content or layout changes.

A disclosure cancels navigation and preserves its trigger edge. Releasing the hold stays resting,
even when collapse clamps the viewport to the end. On native, a last-row bottom-edge hold may mount
the end pin transiently; a reply inserted below that row drops the pin in the same commit.

The existing **Scroll to bottom** control appears when the resting viewport is more than 1 logical
px from the end, or newer history is unloaded. During a landing it uses the wider navigation
threshold. Returning to a retained panel preserves its reading position; hiding cancels navigation.
A fresh route request can land again. Completion, cancellation, failure and final reveal do not
create navigation intent. Reading anchors still handle prepends, virtualization and delayed sizing.

The trigger can only stay put when the list has scroll room for the change. When the loaded
content fits the viewport, or a collapse at the end would need an offset past the end, the list
ends at its end and the trigger moves by the difference.

## Web

`holdRow` pins the row's trigger edge in the reading anchor and runs `apply`; the next reading
reconcile restores that edge after layout, before paint (`strategy-web.tsx`). The pin records the
scroll offset it was taken at, because the browser clamps `scrollTop` when a collapse shrinks the
content past the offset, before the reconcile reads it. Restoring from the clamped offset would
apply the shrink twice.

## Native

On compact layouts, tool calls and tool-call groups open a sheet instead of expanding, so they do
not hold. Summary lines, todo cards, plan cards and show more expand inline.

The timeline is a LegendList in forward order: one `data` array of history rows followed by the
live head, oldest first (`strategy-native.tsx`). LegendList keeps a row in place across a size
change in the commit that makes it, so a hold needs no anchor neighbour, native child index or
render window stretch. The inverted FlatList it replaced needed all three, and three commits per
toggle; its applied commit took up to 3.5 s of JS on a long turn.

### Who owns the offset

One owner keeps the scroll offset at any moment:

| State                  | Owner                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Before rows are placed | LegendList's initial scroll to the end. It keeps the rows hidden until they are measured.                         |
| Explicit end landing   | The end pin (`native-end-pin.tsx`), also for a bottom-edge hold.                                                  |
| Disclosure hold        | LegendList's `maintainVisibleContentPosition` on the hold's anchor row, or the end pin for the last row's bottom. |
| User scroll            | The finger. The controller detaches at drag start.                                                                |
| Resting                | LegendList's `maintainVisibleContentPosition` on the first visible row.                                           |
| Keyboard motion        | Nobody. The keyboard translates the list with the composer and leaves the offset alone.                           |

The end pin is a zero-height view at the bottom of the content and the content's first native
child, with React Native's `maintainVisibleContentPosition` set to `{ minIndexForVisible: 0 }`. The
native correction runs on the UI thread around each mount, so a row that grows or lands at the end
scrolls in the frame it lays out. The controller writes only during explicit navigation through native `scrollToEnd`. A viewport
resize can help an active landing finish; resting resizes never request navigation. Short native
content stays top aligned, since end alignment moves text even at offset zero.

Do not use LegendList's `maintainScrollAtEnd` instead. It scrolls from JS after the mount to the end
its JS sizes predict: growth paints below the viewport for a frame, and the scroll lands short of
the native end, which the controller reads as the user scrolling away.

The keyboard never changes the list's size, padding or offset. `KeyboardTranslateView` moves the list
and the composer together on the UI thread, and the composer viewport clips the top of the list
while the keyboard is open. Do not add a keyboard-sized inset to keep that content reachable: it can
only commit after the motion, and while detached or holding nothing corrects for it, so every row
jumps by the keyboard height after the keyboard settles.

### The hold

`holdRow(rowId, apply, triggerEdge)` runs in the toggle's event:

1. Pick the anchor and detach the controller (`holdForDisclosure`). LegendList restores row
   tops only, so a top-edge hold anchors the toggled row and a bottom-edge hold anchors the row
   below it, whose top is the toggled row's bottom (`disclosureAnchor`). The pin goes away
   and LegendList's `maintainVisibleContentPosition` takes over, restoring only the anchor row
   (`shouldRestorePosition`). A bottom-edge hold while following skips this step: the end pin
   keeps the content end, and the row's bottom with it, in the frame the new height mounts.

   A bottom-edge hold on the last row, such as a prompt the agent has not answered yet, has no
   row below it: its bottom is the content end (the running indicator is the list footer, not a
   row). The hold mounts the end pin while detached, and `apply` runs a frame later. The pin
   anchors only once it is mounted, and a pin that mounts in the same commit as the new height
   anchors nothing. The pin's commit mounts before that frame's JS callbacks run, so `apply`'s
   commit mounts with the pin already in place. The pin keeps the distance from the end, and each
   content size change clamps it to the scroll room left, so the hold clamps if the list was
   at its end when tapped or a collapse used up the room. The release tracks that distance
   instead of reading the offset: the new content size reaches JS before the pin's scroll does.
   A reply landing below the row ends the pin in the commit that mounts the reply, so the reply
   grows below the row and the trigger stays where it was. A reply that lands before `apply` runs
   moves the hold to the reply's row.

   Upstream LegendList anchors only rows from the first fully visible one down to the last fully
   visible one, and a size change with no data change keeps the first row in view whatever
   `shouldRestorePosition` says. A row cut off at the top would then let the row below it hold
   instead, and a bottom-edge anchor just under the viewport would not hold at all. The LegendList
   patch counts the rows cut off at the top, and the row just past the bottom, as in view and
   applies `shouldRestorePosition` to size changes too. It also drops LegendList's Android clamp
   prediction: the scroll view clamps after the adjustment
   ([scroll view corrections](#scroll-view-corrections)), so the prediction moved a collapse near
   the end to the end.

2. Run `apply`.
3. Call the row's `useSyncLayout` trigger. The toggle changes the row from its own state, so
   LegendList's container does not re-render and would learn the new height from `onLayout` a task
   later, after the change painted. The trigger puts the measurement and the corrected positions
   in the toggle's own commit.

The hold ends two frames after the last item size change, since the list measures the toggled row
and any rows it inserted over several frames (`native-disclosure-hold.ts`). The controller remains resting when the hold releases, including within 1 px of the end.

### User scroll

The controller detaches at `onScrollBeginDrag`, so lines that stream in during a drag grow below
the rows under the finger. The detach reaches native a JS round trip after the drag begins, so for
those frames the pin is still mounted. The scroll view subclasses skip the pin's correction while
the user drags (see [scroll view corrections](#scroll-view-corrections)). They skip only the pin's:
in the detached state LegendList uses the same native correction, and a history page that lands
mid-drag needs it. They key on the drag, not the touch, so a tap or long press while following
keeps following.

Reaching the end by wheel, keyboard, scrollbar, swipe or momentum does not start navigation.
A gesture cancels the landing, its verification and blocked requests immediately. Nested tool
scrollers and editable fields keep their own wheel/key ownership. Keyboard/composer motion and
viewport resizing may change geometry; baseline after that movement settles, then further output
must preserve visible text. Keep native jump animation bounded by mounted content and cancel it on
a gesture.

### Draw distance

`drawDistance` is 2000 px on each side of the viewport. A fling over rows that were never measured
blanks the viewport until LegendList renders and measures them. Twelve flings over a chat with a
15,000 px turn expanded, Android emulator, dev build:

| List                          | Blank viewport             | Janky frames | p50 / p90 / p99  |
| ----------------------------- | -------------------------- | ------------ | ---------------- |
| Inverted FlatList             | 1.3 to 1.7 s over 5 flings | 10.8%        | 27 / 48 / 109 ms |
| LegendList, drawDistance 500  | 1.0 to 1.5 s per fling     |              |                  |
| LegendList, drawDistance 2000 | none                       | 1.7%         | 24 / 32 / 48 ms  |

With every turn collapsed, flinging from a cold open into history did not blank at any value from
500 to 2000, and jank followed host load (19 to 40 on 16 cores) rather than draw distance. Measure
1000 and 1500 on the expanded chat, on a host under load 10, before lowering it.

### LegendList patch

`patches/@legendapp+list+3.7.1.patch` carries twelve changes for the timeline. Its header lists
them by purpose, and
[legend-list #593](https://github.com/LegendApp/legend-list/issues/593) reports each upstream.
Drop a hunk when the installed LegendList ships its fix.

### Scroll view corrections

`modules/paseo-scroll` replaces React Native's scroll view on both platforms with a subclass:
Android's `PaseoScrollView` and iOS's `PaseoScrollViewComponentView`.
`VisibleContentPositionClampTest` covers Android; iOS has no native test harness.

**Content clamp.** A mount that shrinks the content while `maintainVisibleContentPosition` is set
applies the shrink twice on both platforms: the scroll view clamps its offset to the new end during
the mount, and React Native then adds the anchor's movement to the clamped offset
([RN #58578](https://github.com/react/react-native/issues/58578), fix in
[PR #58695](https://github.com/react/react-native/pull/58695)). A turn that folds while the list
follows its end lands above the end. Android defers the clamp to the pre-draw pass, and iOS restores
the pre-mount offset for the adjustment and clamps after it.

**Removed anchor (iOS).** A hold removes the end pin in the same mount that opens the tapped
disclosure, and React Native 0.86 on iOS moves the offset by the removed view's frame. The iOS
subclass keeps the offset. Android keeps a removed view's last frame, so it keeps the offset already.
React Native 0.88 skips the adjustment for a removed anchor
([PR #57294](https://github.com/react/react-native/pull/57294)).

**End pin during a drag.** Both subclasses recognize the pin by its native ID, `paseo-end-pin`,
and skip its correction while the user drags ([user scroll](#user-scroll)). This one has no React
Native counterpart; it stays while the timeline uses the pin.

Remove the content clamp and removed-anchor overrides once the installed React Native includes
their fixes.
