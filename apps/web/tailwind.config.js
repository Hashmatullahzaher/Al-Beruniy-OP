/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['"Plus Jakarta Sans"', 'Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        brand: {
          50: '#eef5ff', 100: '#d9e7ff', 200: '#bcd4ff', 300: '#8db6ff',
          400: '#578eff', 500: '#3366ff', 600: '#1f47f5', 700: '#1735e1',
          800: '#192db6', 900: '#1a2c8f', 950: '#141c52',
        },
        gold: {
          50: '#fbf7ee', 100: '#f5eccf', 200: '#ead79f', 300: '#dfbd66',
          400: '#d4a63f', 500: '#c68f2c', 600: '#ab7023', 700: '#89521f',
          800: '#724321', 900: '#61381f', 950: '#381e0f',
        },
        ink: {
          50: '#f6f7f9', 100: '#eceef2', 200: '#d4d9e3', 300: '#adb7ca',
          400: '#808fac', 500: '#5f6f91', 600: '#4b5878', 700: '#3e4862',
          800: '#363d53', 900: '#1c2030', 950: '#0f1119',
        },
      },
      boxShadow: {
        soft: '0 1px 2px rgba(16,24,40,.05), 0 1px 3px rgba(16,24,40,.06)',
        card: '0 4px 24px -8px rgba(16,24,40,.12), 0 2px 8px -4px rgba(16,24,40,.08)',
        float: '0 24px 64px -20px rgba(16,24,40,.35)',
      },
      keyframes: {
        'fade-up': { '0%': { opacity: 0, transform: 'translateY(8px)' }, '100%': { opacity: 1, transform: 'translateY(0)' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
      },
      animation: {
        'fade-up': 'fade-up .5s cubic-bezier(.16,1,.3,1) both',
      },
    },
  },
  plugins: [],
}
