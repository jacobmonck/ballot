import { useState } from "react";

// The first letters of the first two words of a name.
function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

// Falls back to initials when there is no photo or it fails to load, such as an unshared Drive file.
export function PnmPhoto({
  name,
  url,
  className = "",
  onBroken,
}: {
  name: string;
  url: string | null;
  className?: string;
  onBroken?: () => void;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (!url || failedUrl === url) {
    return (
      <div
        className={`flex items-center justify-center bg-stage-lift font-display font-bold tracking-tight text-chalk select-none ${className}`}
        role="img"
        aria-label={`No photo for ${name}`}
      >
        {initials(name)}
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={name}
      referrerPolicy="no-referrer"
      draggable={false}
      className={`bg-stage-lift object-cover select-none ${className}`}
      onError={() => {
        setFailedUrl(url);
        onBroken?.();
      }}
    />
  );
}
