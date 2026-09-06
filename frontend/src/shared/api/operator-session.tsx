import { createContext, useContext } from "react";
export const OperatorReadOnlyContext = createContext(false);
export const useOperatorReadOnly = () => useContext(OperatorReadOnlyContext);
