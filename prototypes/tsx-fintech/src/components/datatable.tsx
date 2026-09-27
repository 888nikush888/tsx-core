import { useState } from "react";
import { flexRender, getCoreRowModel, getFilteredRowModel, getPaginationRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

export function DataTable<T>({ spalten, daten, suchPlatzhalter = "Filtern …", leerText = "Keine Eintraege." }: {
  spalten: ColumnDef<T, unknown>[]; daten: T[]; suchPlatzhalter?: string; leerText?: string }) {
  const [sortierung, setSortierung] = useState<SortingState>([]);
  const [filter, setFilter] = useState("");
  const tabelle = useReactTable({ data: daten, columns: spalten, state: { sorting: sortierung, globalFilter: filter },
    onSortingChange: setSortierung, onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(), getPaginationRowModel: getPaginationRowModel() });
  return (
    <div className="flex flex-col gap-2">
      <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={suchPlatzhalter} aria-label="Tabelle filtern" className="max-w-sm" />
      <div className="overflow-x-auto rounded-none border">
        <Table>
          <TableHeader>{tabelle.getHeaderGroups().map((g) => (
            <TableRow key={g.id}>{g.headers.map((h) => (
              <TableHead key={h.id}>
                {h.isPlaceholder ? null : (
                  <button type="button" className="font-medium" onClick={h.column.getToggleSortingHandler()} aria-label="Sortieren">
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {{ asc: " ▲", desc: " ▼" }[h.column.getIsSorted() as string] ?? null}
                  </button>)}
              </TableHead>))}</TableRow>))}
          </TableHeader>
          <TableBody>
            {tabelle.getRowModel().rows.length === 0 ? (
              <TableRow><TableCell colSpan={spalten.length}>
                <Empty><EmptyHeader><EmptyTitle>Leer</EmptyTitle><EmptyDescription>{leerText}</EmptyDescription></EmptyHeader></Empty>
              </TableCell></TableRow>
            ) : tabelle.getRowModel().rows.map((r) => (
              <TableRow key={r.id}>{r.getVisibleCells().map((z) => (
                <TableCell key={z.id}>{flexRender(z.column.columnDef.cell, z.getContext())}</TableCell>))}</TableRow>))}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>Seite {tabelle.getState().pagination.pageIndex + 1} von {tabelle.getPageCount() || 1}</span>
        <span className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => tabelle.previousPage()} disabled={!tabelle.getCanPreviousPage()}>Zurueck</Button>
        <Button variant="outline" size="sm" onClick={() => tabelle.nextPage()} disabled={!tabelle.getCanNextPage()}>Weiter</Button>
      </div>
    </div>
  );
}
