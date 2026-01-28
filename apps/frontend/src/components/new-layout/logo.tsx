'use client';

export const Logo = () => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="60"
      height="60"
      viewBox="0 0 60 60"
      fill="none"
      className="mt-[8px] min-w-[60px] min-h-[60px]"
    >
      <defs>
        {/* Teal to Cyan gradient (left side) */}
        <linearGradient id="tealGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#2BD39E" />
          <stop offset="100%" stopColor="#2BB6D3" />
        </linearGradient>
        
        {/* Blue gradient (top-right) */}
        <linearGradient id="blueGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#2B6BD3" />
          <stop offset="100%" stopColor="#2B45D3" />
        </linearGradient>
      </defs>
      
      {/* 3D Interlocking N Logo - Continuous ribbon shape */}
      {/* Left vertical segment (teal gradient) */}
      <path
        d="M12 8 L12 20 L18 20 L18 15 L25 15 L25 20 L30 20 L30 8 Z"
        fill="url(#tealGradient)"
      />
      
      {/* Diagonal segment connecting left to right (teal to blue transition) */}
      <path
        d="M30 8 L35 8 L40 15 L35 20 L30 20 Z"
        fill="url(#tealGradient)"
        opacity="0.9"
      />
      
      {/* Top horizontal segment (blue gradient) */}
      <path
        d="M35 8 L50 8 L50 15 L45 15 L45 12 L40 12 L40 15 L35 15 Z"
        fill="url(#blueGradient)"
      />
      
      {/* Right vertical segment (blue gradient) */}
      <path
        d="M50 8 L50 25 L45 25 L45 20 L40 20 L40 25 L35 25 L35 15 L40 12 L45 12 L50 15 Z"
        fill="url(#blueGradient)"
      />
      
      {/* Bottom horizontal segment (grey-blue) */}
      <path
        d="M12 20 L30 20 L30 25 L25 25 L25 30 L18 30 L18 35 L12 35 Z"
        fill="#778BA3"
      />
      
      {/* Right bottom segment (grey-blue) */}
      <path
        d="M30 25 L45 25 L45 30 L40 30 L40 35 L35 35 L35 30 L30 30 Z"
        fill="#778BA3"
      />
      
      {/* Bottom right vertical (grey-blue) */}
      <path
        d="M45 30 L50 30 L50 52 L45 52 L45 35 L40 35 L40 52 L35 52 L35 35 Z"
        fill="#778BA3"
      />
      
      {/* Left bottom vertical (teal gradient) */}
      <path
        d="M12 35 L18 35 L18 40 L25 40 L25 52 L12 52 Z"
        fill="url(#tealGradient)"
        opacity="0.8"
      />
      
      {/* Connecting segment (grey-blue) */}
      <path
        d="M25 40 L35 40 L35 45 L30 45 L30 52 L25 52 Z"
        fill="#778BA3"
      />
    </svg>
  );
};
