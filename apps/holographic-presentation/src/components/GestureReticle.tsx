import React from 'react';
import type { GestureState } from '../types/presentation';

interface GestureReticleProps {
  gestureState: GestureState;
}

export const GestureReticle: React.FC<GestureReticleProps> = ({ gestureState }) => {
  if (!gestureState.isTracking || gestureState.activeGesture === 'none') {
    return null;
  }

  const screenX = gestureState.cursorScreenPos.x * window.innerWidth;
  const screenY = gestureState.cursorScreenPos.y * window.innerHeight;

  const isPinching = gestureState.isPinching;

  return (
    <div
      className="fixed pointer-events-none z-50 transition-all duration-75 transform -translate-x-1/2 -translate-y-1/2"
      style={{
        left: `${screenX}px`,
        top: `${screenY}px`
      }}
    >
      {/* Outer Holographic Sonar Ring */}
      <div
        className={`w-14 h-14 rounded-full border-2 transition-all duration-200 flex items-center justify-center ${
          isPinching
            ? 'border-amber-400 bg-amber-400/20 scale-75 shadow-lg shadow-amber-400/80'
            : 'border-cyan-400 bg-cyan-400/10 scale-100 shadow-md shadow-cyan-400/50'
        }`}
      >
        {/* Center Target Dot */}
        <div
          className={`w-2.5 h-2.5 rounded-full transition-colors ${
            isPinching ? 'bg-amber-300' : 'bg-cyan-300'
          }`}
        />

        {/* Crosshair Tick Marks */}
        <div className="absolute -top-1 w-0.5 h-2 bg-cyan-400" />
        <div className="absolute -bottom-1 w-0.5 h-2 bg-cyan-400" />
        <div className="absolute -left-1 w-2 h-0.5 bg-cyan-400" />
        <div className="absolute -right-1 w-2 h-0.5 bg-cyan-400" />
      </div>

      {/* Gesture State Label Tag */}
      <div className="absolute top-8 left-1/2 -translate-x-1/2 whitespace-nowrap px-2 py-0.5 rounded bg-slate-950/80 backdrop-blur border border-cyan-500/50 text-[10px] font-mono uppercase text-cyan-300 tracking-wider shadow">
        {gestureState.activeGesture.replace('_', ' ')}
      </div>
    </div>
  );
};
