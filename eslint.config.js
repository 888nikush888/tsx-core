import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.jest
      }
    },
    rules: {
      "no-unused-vars": "warn",
      "no-empty": "warn",
      "no-constant-condition": ["error", { "checkLoops": false }],
      "no-useless-assignment": "off",
      "no-control-regex": "off"
    }
  }
];
