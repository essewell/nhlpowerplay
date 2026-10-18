import Image from "next/image";
import { t } from "../../lib/copy.ts";
import { cx } from "./cx.ts";

export type Grade = "best" | "close" | "costly" | "miss";
export type GradeIconSize = 16 | 24 | 48;

/**
 * Grade mark: the SVG tile from /grades plus the grade word. Shape (check, dot, triangle, cross)
 * carries the grade, the word backs it up, so colour is never the only signal.
 * `showWord={false}` is for dense strips: the word then moves into the image alt text.
 */
export function GradeChip({
  grade,
  size = 16,
  showWord = true,
  className,
}: {
  grade: Grade;
  size?: GradeIconSize;
  showWord?: boolean;
  className?: string;
}) {
  const word = t(`grade.${grade}`);
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-xs text-text-soft", className)}>
      <Image
        src={`/grades/grade-${grade}.svg`}
        alt={showWord ? "" : word}
        width={size}
        height={size}
        unoptimized
        className="block shrink-0"
      />
      {showWord ? <span>{word}</span> : null}
    </span>
  );
}
