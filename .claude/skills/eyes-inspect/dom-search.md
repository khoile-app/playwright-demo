# dom-search predicate language

`dom-search` searches a DOM capture (the JSON produced by eyes-inspect's `dom` command) for elements matching a predicate, and prints one line per match — indented to show its depth in the tree.

Only real tag elements are matched; text and comment nodes are never matched directly. Every element also gets a virtual `text` property: the concatenation of its own direct text content. A matching element with non-empty text has that text appended to its output line after a `#`.

A predicate is one of seven kinds of check — a **property comparison**, a **bounds (geometry) check**, a **size comparison**, a **direction check**, a **relationship check**, an **attribute-presence check**, or a **shortcut keyword** — combined with `and`, `or`, `not`, and parentheses.

Several of these checks need to reference *another* element rather than the one being tested. Do that with `node <id>`, using the element's `id` field — e.g. `node 12`; it shows up in bounds checks, size comparisons, direction checks, and relationship checks below. Relationship checks additionally accept a sub-predicate in place of `node <id>`, describing the other element instead of naming its id — see "Checking relationships" below.

## Boolean combinations

Combine any predicates with `and`, `or`, `not` (or the symbols `&&`, `||`, `!`) and parentheses. `not` binds tighter than `and`, which binds tighter than `or` — same as most programming languages. Use parentheses to override that.

```
image and gif
tagName = 'DIV' or tagName = 'SPAN'
not (tagName = 'SPAN')
```

## Comparing a property

Reference a property by its path — `tagName`, `attributes.class`, `attributes.data-testid`, `style.display`, `rect.width`, `rect.left`, or the virtual `text` property — and compare it to a value:

- **Equality**: `=` or `equals`, and `!=` or `not-equals`.
- **Ordering** (numeric — also handles CSS lengths like `"16px"`): `<`/`less-than`, `<=`/`less-than-or-equal`, `>`/`greater-than`, `>=`/`greater-than-or-equal`.
- **String matching**: `starts-with`, `ends-with`, `contains`.
- **Regex**: `matches`, `regex`, or `=~`, with the value written as `/pattern/flags`.
- **Membership**: `in`, with a parenthesized, comma-separated list of values.

String comparisons are case-insensitive. A property that doesn't exist on an element just fails to match — it never causes an error. Examples:

```
tagName = 'DIV'
attributes.class contains 'btn'
rect.width > 200
style.display != 'none'
attributes.href starts-with 'https://'
tagName =~ /^H[1-6]$/
attributes.type in ('button', 'submit', 'reset')
```

Values with no spaces can be written bare (`tagName = DIV`). A value containing spaces or special characters must be single-quoted (`attributes.class = 'nav item'`) — there is no double-quoted form, so a literal `"` never needs escaping and isn't itself an escape sequence. Inside a quoted value, `\'`, `\\`, `\n`, `\t`, and `\r` are recognized escapes — so `text = 'line one\nline two'` matches an element whose text spans two lines. A regex literal (`/pattern/flags`) doesn't need this — its own `\n`/`\t`/etc. are interpreted by the regex engine directly.

## Checking geometry

Test an element's bounding rectangle against a point, a rectangle, or another element:

```
bounds contains 400,300              (a point, "x,y")
bounds contains 0,0,500,200          (a rectangle, "left,top,width,height")
bounds contains node 12              (the element with id 12)
bounds intersects node 12
bounds contained-by node 12
```

`bounds` and `rect` are interchangeable here. An element with no rectangle never matches a geometry check. (Writing `rect.width` or another dotted path still works as an ordinary property comparison — only a bare `rect`/`bounds` followed directly by `contains`/`intersects`/`contained-by` is a geometry check.)

## Comparing size

Compare an element's area, width, or height against a literal number, another element's dimensions, or a plain size/rectangle:

```
larger-than node 12          (area bigger than element 12's area)
smaller-than 5000            (area smaller than 5000 square px)
wider-than node 12           (width greater than element 12's width)
narrower-than 300            (width less than 300px)
taller-than 0,0,200,80       (height greater than 80 — a rect's own height, position ignored)
shorter-than 200,80          (height less than 80 — a plain "width,height" size)
```

The target can be `node <id>` (use that element's dimensions), a rectangle (4 numbers — only its width/height matter, not its position), a plain size (2 numbers, `width,height`), or a single bare number — interpreted as area for `larger-than`/`smaller-than`, width for `wider-than`/`narrower-than`, height for `taller-than`/`shorter-than`. An element with no rectangle (as either the subject or the `node` target) never matches.

## Checking direction

Test whether an element is entirely above, below, left of, or right of another element or rectangle — not just overlapping it, but fully past the relevant edge:

```
above node 12
below node 12
left-of node 12
right-of 0,0,500,200
```

`right-of T` means entirely to the right of T's right edge; `left-of T` entirely to the left of T's left edge; `above`/`below` work the same way against T's top/bottom edge. An element that merely overlaps the target matches none of the four.

## Checking relationships

Test an element's position in the tree relative to another element:

```
descendant-of node 12
ancestor-of node 12
child-of node 12
parent-of node 12
sibling-of node 12
2nd child-of node 12
first child-of node 12
```

Ordinal forms (`1st`, `2nd`, ... `20th`, or `first`, `second`, ... `twentieth`) count only element children, ignoring text.

Instead of `node <id>`, you can give a whole sub-predicate in parentheses, describing the other element instead of naming it — this lets you say "some ancestor/descendant/sibling that looks like X" without knowing its id:

```
child-of (tagName = 'FORM')
2nd child-of (ancestor-of text and tagName = 'BUTTON')
```

The second example reads as: "the 2nd child of some element that is itself a BUTTON with a descendant that has text."

## Checking attribute presence

Test whether an element has a given attribute at all, regardless of its value:

```
has-attribute src
has-attribute 'data-testid'
```

The name is matched case-insensitively and can be written bare (no spaces) or single-quoted. This differs from `attributes.<name> != ''` in one case: an attribute present with an empty value (e.g. `alt=""`) counts as present for `has-attribute`, but would fail a `!= ''` check.

## Shortcut keywords

A handful of common checks are a single word, with no operator or value:

| Keyword | Matches |
|---|---|
| `text` | Has non-empty text |
| `image` | Looks like a visual image (broad heuristic — see below) |
| `gif` | Is an `IMG` (specifically, not the broader `image` set) whose `src` ends with `.gif` |
| `logo` | `class`/`id`/`alt` contains "logo" |
| `link` | Is an `A` |
| `button` | Is a `BUTTON`, a `button`/`submit`/`reset` `INPUT`, or has `role="button"` |
| `heading` | Is `H1` through `H6` |
| `hidden` | `display:none`, `visibility:hidden`, `opacity:0`, zero width/height (or no rect), or has a `hidden` attribute |
| `visible` | The exact inverse of `hidden` |
| `empty` | Has no text and no element children |
| `true` | Always matches — every element |
| `false` | Never matches |

`image` is a broad heuristic, not a single structural check — it's meant to answer "does this look like an image to a person looking at the page", not "is this literally an `<img>` tag". It matches any of:

- an `IMG`, `SVG`, or `PICTURE` element (by tag, regardless of attributes)
- any element with a CSS `background-image` other than `none`

Because it's a heuristic, expect both false positives and false negatives: a `DIV` styled with a decorative `background-image` counts as an "image" even though it's not meaningfully one, while an icon rendered via an icon font (a glyph character styled with a special font, no image-related attribute or style at all) is invisible to this check and will never match. When you need the strict "literally an `<img>` tag" meaning instead, write `tagName = 'IMG'` directly.

**Results include hidden elements by default** — dom-search doesn't filter anything out unless the predicate says so, since silently hiding a match is worse than an unwanted one (you might be searching precisely because an element is unexpectedly hidden). **To skip hidden elements, start the predicate with `visible and ...`**, e.g. `visible and tagName = 'BUTTON'`.

## More examples

```
tagName = 'DIV' and attributes.class contains 'btn'
image and gif
heading and text
rect.width > 200 and not (tagName = 'SPAN')
attributes.type in ('button', 'submit')
bounds contains 400,300
descendant-of node 12
larger-than node 12
right-of node 12
has-attribute 'aria-label'
```
