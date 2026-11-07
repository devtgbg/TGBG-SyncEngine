/**
 * The Golf Buggy Guy's buggy, as the dashboard's mark.
 *
 * The buggy sits on a rounded chip of the brand's deep green, which is what makes its own palette
 * constant: the drawing never meets the page, so it does not have to survive a near-white bar in light
 * mode and a near-black one in dark. Only the chip itself lifts a shade in dark mode, so it still reads
 * as a shape against #17161a.
 *
 * The tokens are assigned by WHAT EACH SHAPE SITS ON rather than by what colour it was in the drawing —
 * the front struts and the steering column are thin marks lying on the chip, so they take the structural
 * token, while the dash and the footwell are recesses inside larger shapes and take the deep one.
 * Swapping those two loses the struts against the chip.
 *
 * The drawing itself is untouched: every path, circle and rect is exactly as supplied, and only the
 * fills and strokes were replaced with tokens.
 */
export function BuggyMark() {
  return (
    <svg className="brand-mark" viewBox="38 30 222 172" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id="tgbg-buggy-body">
          <path d="M44 152 Q45.5 144 55 143.5 L88 142.5 Q95 142.5 97 149 L99 153 Q100.5 155.5 105 155.5 L136.5 155.5 L136.5 162 Q136.5 167 142 166.5 L180 164 Q195 162 206 152 Q215 145 228 144.5 L246.5 141 Q251.5 142 252 149 L252.5 163 Q252.5 167 249.5 164.5 L245.5 159 L244 172 L201 177.5 Q160 178.5 120 178 L50 176 Q44 170 44 160 Z" />
        </clipPath>
      </defs>

      {/* Rear struts */}
      <path d="M199.5 54 Q203 72 197.5 92 L201.5 92 Q206.5 72 203.5 53 Z" fill="var(--logo-frame)" />
      <path d="M205.5 49 L211.5 47 Q216.5 68 215 91 L209.5 91 Q211 68 205.5 49 Z" fill="var(--logo-frame)" />

      {/* Canopy */}
      <rect x="86" y="37" width="131" height="9.5" rx="4.75" fill="var(--logo-panel)" />
      <path d="M87.5 44 L215 43.5 Q212 50.5 202 52 L101 54 Q88.5 54 87.5 44 Z" fill="var(--logo-frame)" />

      {/* Front struts — strokes lying on the page, so structural, not deep */}
      <path d="M107 41 L76.5 114 L84 141" fill="none" stroke="var(--logo-frame)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M112.5 51 L85 113 L90.5 141" fill="none" stroke="var(--logo-frame)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />

      {/* Rear body / bag well */}
      <path d="M203 89 L214 89.5 L232.5 91.5 Q236 92.5 235.5 95.5 Q235 97.5 232 98 L222.5 99 L226 126 L188 128 Z" fill="var(--logo-frame)" />

      {/* Seat back */}
      <path d="M189 89 L203 89 L192 110.5 L177.5 112.5 L184 94 Q186 89 189 89 Z" fill="var(--logo-panel)" />

      {/* Front cowl */}
      <path d="M51 150 Q54 127 77 121 L84 120 L92 150 Z" fill="var(--logo-panel)" />

      {/* Rear body */}
      <path d="M139.5 123 L239 124 Q243 125.5 244.5 132 L246 143 L190 168 L141 170 Q136.5 170 136.5 165 L136.5 127 Q136.5 123 139.5 123 Z" fill="var(--logo-panel)" />

      {/* Seat cushion, and its highlight */}
      <path d="M147 136 Q150 124 160 116 Q168 110.5 180 109.5 L193 108.5 Q196.5 108.5 195 111.5 L186.5 128 Q184.5 132 179.5 133 L152 138 Q146 139 147 136 Z" fill="var(--logo-frame)" />
      <path d="M156.5 131.5 Q160 124 167.5 118.5 L171 120.5 L177 119.5 L181 114.5 L189.5 113.5 L182.5 127 Z" fill="var(--logo-panel)" />

      {/* Chassis */}
      <path d="M44 152 Q45.5 144 55 143.5 L88 142.5 Q95 142.5 97 149 L99 153 Q100.5 155.5 105 155.5 L136.5 155.5 L136.5 162 Q136.5 167 142 166.5 L180 164 Q195 162 206 152 Q215 145 228 144.5 L246.5 141 Q251.5 142 252 149 L252.5 163 Q252.5 167 249.5 164.5 L245.5 159 L244 172 L201 177.5 Q160 178.5 120 178 L50 176 Q44 170 44 160 Z" fill="var(--logo-frame)" />

      {/* Footwell — a recess inside the chassis */}
      <path d="M93 142.6 Q95.5 143.5 97 149 L99 153 Q100.5 155.5 105 155.5 L136.5 155.5 L136.5 166 Q136.5 171 131.5 171 L104 171 Q99 171 97.5 166 Z" fill="var(--logo-shadow)" />

      {/* Dash — a recess inside the cowl */}
      <path d="M85 121 Q86 112.5 91 113 Q94.5 113.5 94.5 120 L95 128 Q100 134 99.5 148 Q99.5 151 96 151 L93 151 Q91 151 90 148 Q86 136 85 121 Z" fill="var(--logo-shadow)" />

      {/* Steering — also lying on the page */}
      <path d="M93 128 L127.5 99.5" stroke="var(--logo-frame)" strokeWidth="3.6" strokeLinecap="round" />
      <path d="M121.5 84.5 L140 103.5 L127.5 99.5 Z" fill="var(--logo-frame)" stroke="var(--logo-frame)" strokeWidth="1.6" strokeLinejoin="round" />

      {/* Wheel wells, clipped to the body */}
      <g clipPath="url(#tgbg-buggy-body)" fill="var(--logo-shadow)">
        <circle cx="64" cy="176" r="24" />
        <circle cx="222" cy="176" r="24" />
      </g>

      {/* Wheels */}
      <circle cx="64" cy="176" r="21" fill="var(--logo-frame)" />
      <circle cx="64" cy="176" r="12.5" fill="var(--logo-hub)" />
      <circle cx="222" cy="176" r="21" fill="var(--logo-frame)" />
      <circle cx="222" cy="176" r="12.5" fill="var(--logo-hub)" />
    </svg>
  );
}
