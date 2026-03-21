/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      animation: {
        // Define una rotación lenta de 3 segundos
        'spin-slow': 'spin 3s linear infinite',
      },
    },
  },
  plugins: [],
}
