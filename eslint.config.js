import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "coverage/**"],
  },
  {
    files: ["src/**/*.js", "scripts/**/*.mjs", "test/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "no-constant-binary-expression": "error",
      "no-dupe-else-if": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
    },
  },
];
