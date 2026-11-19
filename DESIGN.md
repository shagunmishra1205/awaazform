# AwaazForm design system

The existing implementation in apps/web/app/globals.css and CLAUDE.md is authoritative.

## Theme and color

Light surfaces for people completing forms on phones and desktops in everyday surroundings. Use --surface, --bg-subtle, --text and --text-muted. Violet --accent identifies primary actions; --accent-text is the accessible foreground. High contrast is controlled by data-contrast, not the device color scheme.

## Typography

Inter for interface text and headings, Noto families for Indian scripts, Fira Code for transcripts. Use the existing font variables and respect the large-text setting.

## Components and layout

Use .btn, .btn-ghost and .btn-quiet with 44px minimum targets. Use existing radius, border and shadow variables. Respect mobile safe areas, logical inline spacing and narrow viewports. Installation notices belong below the content with enough reserved space to keep controls reachable.

## Motion

Use the existing easing tokens and respect both system and application reduced-motion preferences.
