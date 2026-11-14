import { useState } from 'react';

interface PosterThumbProps {
  name: string;
  posterUrl: string | null;
}

const PosterThumb = ({ name, posterUrl }: PosterThumbProps) => {
  const [failed, setFailed] = useState(false);

  if (!posterUrl || failed) {
    return (
      <div
        aria-hidden="true"
        className="flex h-12 w-8 shrink-0 items-center justify-center rounded bg-gradient-to-br from-stone-700 to-stone-800 text-xs text-gray-300"
      >
        {name.charAt(0).toUpperCase()}
      </div>
    );
  }

  return (
    <img
      src={posterUrl}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-12 w-8 shrink-0 rounded bg-stone-700 object-cover"
    />
  );
};

export default PosterThumb;
