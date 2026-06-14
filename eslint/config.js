const js = require("@eslint/js");

module.exports = [
  // Global ignores must live in their own config object (with no other keys)
  // to apply repo-wide in flat config.
  { ignores: ["node_modules/**", "public/**", "admin-pages/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
        process: "readonly",
        console: "readonly",
        __dirname: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        Buffer: "readonly",
      },
    },
    rules: {
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_|^next$|^req$|^res$" },
      ],
    },
  },
];
