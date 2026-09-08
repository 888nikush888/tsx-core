import { useState } from 'react';
import type { WorkflowGraph, WorkflowResource } from '@/app/workflow/types';

export function GraphTable({ graph, resources, readOnly, edit, connect, remove }: Readonly<{ graph: WorkflowGraph; resources: WorkflowResource[]; readOnly: boolean;
  edit: (id: string) => void; connect: (source: string, target: string) => void; remove: (id: string) => void }>) {
  const [filter, setFilter] = useState(''); const [source, setSource] = useState(''); const [target, setTarget] = useState('');
  const byId = new Map(resources.map(resource => [resource.id, resource]));
  const currentSource = graph.nodes.some(node => node.id === source) ? source : '';
  const currentTarget = target !== currentSource && graph.nodes.some(node => node.id === target) ? target : '';
  const canConnect = !readOnly && Boolean(currentSource) && Boolean(currentTarget);
  const connectSelected = () => { if (canConnect) connect(currentSource, currentTarget); };
  const name = (id: string) => { const node = graph.nodes.find(item => item.id === id); return node ? byId.get(node.resourceVersionId)?.name ?? id : id; };
  return <section className="operations-card system-form"><h2>Graph als Tabelle</h2><label>Bausteine filtern<input value={filter} onChange={event => setFilter(event.target.value)} /></label>
    <div className="overflow-x-auto"><table className="w-full text-left"><caption>Dieselben Bausteine und Verbindungen wie im Canvas</caption><thead><tr><th scope="col">Baustein</th><th scope="col">Typ</th><th scope="col">Version / Zustand</th><th scope="col">Ausgänge / Scope</th><th scope="col">Bedienung</th></tr></thead><tbody>{graph.nodes.filter(node => `${name(node.id)} ${node.kind}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map(node => {
      const resource = byId.get(node.resourceVersionId);
      return <tr key={node.id}><th scope="row" className="p-2">{name(node.id)}</th><td>{node.kind}</td><td>{resource?.version ?? 'unbekannt'} · {resource?.status ?? 'unbekannt'}<br />{node.resourceVersionId}</td><td>{graph.edges.filter(edge => edge.source === node.id).map(edge => <p key={edge.id}>{name(edge.target)} · {edge.kind ?? 'flow'} · {edge.channelNodeIds?.map(name).join(', ') ?? 'alle eingehenden Kanäle'} {edge.fallbackOn?.join(', ')} <button className="secondary-button" disabled={readOnly} onClick={() => remove(edge.id)}>Verbindung {edge.id} entfernen</button></p>)}</td><td><button className="secondary-button" disabled={readOnly} onClick={() => edit(node.id)}>Baustein {name(node.id)} bearbeiten</button></td></tr>;
    })}</tbody></table></div>
    <fieldset disabled={readOnly}><legend>Normale Verbindung anlegen</legend><label>Von<select value={currentSource} onChange={event => setSource(event.target.value)}><option value="">Quelle wählen</option>{graph.nodes.map(node => <option key={node.id} value={node.id}>{name(node.id)} · {node.kind}</option>)}</select></label><label>Nach<select value={currentTarget} onChange={event => setTarget(event.target.value)}><option value="">Ziel wählen</option>{graph.nodes.filter(node => node.id !== currentSource).map(node => <option key={node.id} value={node.id}>{name(node.id)} · {node.kind}</option>)}</select></label><button className="primary-button" disabled={!canConnect} onClick={connectSelected}>Verbindung im Entwurf anlegen</button></fieldset><p>Der Server prüft Reihenfolge und erlaubte Bausteinkombinationen. Fallbacks werden mit ihren sicheren Gründen und ihrem Kanalscope im bestehenden Fallbackformular bearbeitet.</p>
  </section>;
}
