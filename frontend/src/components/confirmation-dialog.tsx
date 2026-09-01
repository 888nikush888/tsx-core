import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export type ConfirmationDialogOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmationText?: string;
  inputLabel?: string;
  inputPlaceholder?: string;
  inputRequired?: boolean;
  destructive?: boolean;
};

export function useConfirmationDialog() {
  const [options, setOptions] = useState<ConfirmationDialogOptions | null>(null);
  const [input, setInput] = useState("");
  const resolver = useRef<((value: string | null) => void) | null>(null);

  const settle = useCallback((value: string | null) => {
    resolver.current?.(value);
    resolver.current = null;
    setOptions(null);
    setInput("");
  }, []);

  useEffect(() => () => resolver.current?.(null), []);

  const confirm = useCallback((request: ConfirmationDialogOptions) => {
    resolver.current?.(null);
    setInput("");
    setOptions(request);
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const needsInput = Boolean(options?.confirmationText || options?.inputLabel || options?.inputRequired);
  const valid = options?.confirmationText
    ? input === options.confirmationText
    : options?.inputRequired
      ? input.trim().length > 0
      : true;

  const confirmationDialog = (
    <Dialog open={Boolean(options)} onOpenChange={(open) => !open && settle(null)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{options?.title}</DialogTitle>
          <DialogDescription className="app-confirmation-description">
            {options?.description}
          </DialogDescription>
        </DialogHeader>
        {needsInput && (
          <label className="app-confirmation-input">
            {options?.inputLabel || (options?.confirmationText
              ? `Zur Bestätigung exakt „${options.confirmationText}“ eingeben`
              : "Eingabe")}
            <Input
              autoFocus
              autoComplete="off"
              value={input}
              placeholder={options?.inputPlaceholder}
              onChange={(event) => setInput(event.target.value)}
            />
          </label>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => settle(null)}>
            {options?.cancelLabel || "Abbrechen"}
          </Button>
          <Button
            type="button"
            variant={options?.destructive ? "destructive" : "default"}
            disabled={!valid}
            onClick={() => settle(needsInput ? input.trim() : "confirmed")}
          >
            {options?.confirmLabel || "Bestätigen"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirm, confirmationDialog };
}
