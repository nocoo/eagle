export function SlotBar({
  items,
  ariaLabel,
  heightClass,
  gapClass,
}: {
  items: { color: string }[];
  ariaLabel: string;
  heightClass: string;
  gapClass: string;
}) {
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      className={`flex min-w-0 flex-1 items-stretch ${gapClass}`}
    >
      {items.map((item, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={`min-w-0 flex-1 ${heightClass}`}
          style={{ backgroundColor: item.color }}
        />
      ))}
    </span>
  );
}
