/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["../static/index.html", "../static/app.js"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "-apple-system", "BlinkMacSystemFont", "SF Pro Text", "PingFang SC",
          "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "sans-serif",
        ],
      },
      colors: {
        ink: "#0f172a",
        wc: { DEFAULT: "#0f766e", soft: "#e3f1ef" },
        ai: { DEFAULT: "#4338ca", soft: "#e8e9fb" },
        teamA: "#0f766e",
        teamB: "#ea580c",
      },
      boxShadow: {
        card: "0 1px 2px rgba(15,23,42,.04), 0 1px 1px rgba(15,23,42,.02)",
      },
      borderRadius: { xl2: "0.875rem" },
    },
  },
  plugins: [require("daisyui")],
  daisyui: {
    logs: false,
    themes: [
      {
        evalboard: {
          primary: "#0f766e",
          "primary-content": "#ffffff",
          secondary: "#4338ca",
          "secondary-content": "#ffffff",
          accent: "#ea580c",
          neutral: "#0f172a",
          "base-100": "#ffffff",
          "base-200": "#f6f7f9",
          "base-300": "#e6e9ef",
          "base-content": "#0f172a",
          info: "#0ea5e9",
          success: "#16a34a",
          warning: "#f59e0b",
          error: "#dc2626",
          "--rounded-box": "0.875rem",
          "--rounded-btn": "0.5rem",
          "--rounded-badge": "0.375rem",
        },
      },
    ],
  },
};
