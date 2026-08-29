/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        surface: '#FFFFFF',
        canvas: '#F8FAFC',
        border: '#E5E7EB',
        primary: {
          DEFAULT: '#2563EB',
          hover: '#1D4ED8',
          soft: '#EFF6FF',
        },
        success: '#22C55E',
        warning: '#F59E0B',
        danger: '#EF4444',
        ink: {
          DEFAULT: '#111827',
          muted: '#6B7280',
          faint: '#9CA3AF',
        },
      },
      borderRadius: {
        xl: '12px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(17, 24, 39, 0.04), 0 1px 3px rgba(17, 24, 39, 0.06)',
        lift: '0 4px 12px rgba(17, 24, 39, 0.08)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      transitionDuration: {
        DEFAULT: '150ms',
      },
      animation: {
        shimmer: 'shimmer 1.5s infinite',
        pulseSoft: 'pulseSoft 2s ease-in-out infinite',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
      },
    },
  },
  plugins: [],
};
