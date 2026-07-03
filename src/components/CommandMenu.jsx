import { useMemo } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";

// Bucket the flat command list into cmdk groups, preserving order:
// ungrouped actions first, then Project / Agent / Plan / Theme sections.
function groupCommands(commands) {
  const groups = new Map();
  for (const c of commands) {
    const key = c.group ?? "Commands";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return [...groups.entries()];
}

export default function CommandMenu({ open, onOpenChange, commands }) {
  const groups = useMemo(() => groupCommands(commands), [commands]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command Menu"
      description="Search for a command to run"
      showCloseButton={false}
      className="cmdk-dialog"
    >
      <CommandInput placeholder="Type a command…" />
      <CommandList>
        <CommandEmpty>No matching commands.</CommandEmpty>
        {groups.map(([name, items]) => (
          <CommandGroup key={name} heading={name}>
            {items.map((c) => (
              <CommandItem
                key={c.id}
                value={`${name} ${c.label}`}
                onSelect={() => {
                  onOpenChange(false);
                  c.action();
                }}
              >
                {c.label}
                {c.hint && <CommandShortcut>{c.hint}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
