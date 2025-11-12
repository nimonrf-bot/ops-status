"use client";
import React, { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Edit, Save, X, Search, Ship, Warehouse as WIcon, MapPin, Timer, RefreshCw, Settings, LogIn, LogOut, ShieldCheck, CheckCircle2, AlertTriangle } from "lucide-react";

// ---- Firebase SDK (safe client init; no process.env) ----
import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getFirestore, collection, onSnapshot, addDoc, doc, updateDoc, deleteDoc, serverTimestamp, query as fsQuery, orderBy, getDoc, type Firestore } from "firebase/firestore";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut, type Auth, type User } from "firebase/auth";

// ---- Types ----
type WarehouseT = {
  id: string;
  name: string;
  location: string;
  capacityTons: number;
  usedTons: number;
  status: "OK" | "Full" | "Critical" | "Closed";
  lastUpdate: string; // ISO date
};

type VesselT = {
  id: string;
  name: string;
  cargo: string;
  tonnage: number;
  status: "At Sea" | "Loading" | "Discharging" | "Anchored" | "Delayed";
  etaPort?: string; // e.g., "Astrakhan", "Anzali"
  eta?: string; // ISO date
  lastPosition?: string; // simple textual position
};

type FirebaseConfig = { apiKey: string; authDomain: string; projectId: string; };

type Mode = "demo" | "cloud";

// ---- Utilities ----
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "–");
const pct = (used: number, cap: number) => Math.min(100, Math.round((used / Math.max(cap, 1)) * 100));

// ---- Demo sample data ----
const SAMPLE_DATA = {
  warehouses: [
    { id: "w1", name: "Caspian Port – Main Silo", location: "Anzali", capacityTons: 30000, usedTons: 18250, status: "OK", lastUpdate: new Date().toISOString() },
    { id: "w2", name: "Caspian Port – Shed B", location: "Amirabad", capacityTons: 8000, usedTons: 7800, status: "Full", lastUpdate: new Date().toISOString() },
    { id: "w3", name: "ARIB Yard", location: "Astrakhan", capacityTons: 12000, usedTons: 10800, status: "Critical", lastUpdate: new Date().toISOString() },
  ] as WarehouseT[],
  vessels: [
    { id: "v1", name: "OMSKIY-128", cargo: "Corn", tonnage: 3000, status: "Anchored", etaPort: "Astrakhan", eta: new Date(Date.now() + 36*3600*1000).toISOString(), lastPosition: "Volga delta anchorage" },
    { id: "v2", name: "OMSKIY-131", cargo: "Clinker", tonnage: 3500, status: "Discharging", etaPort: "Caspian Port", eta: new Date(Date.now() + 12*3600*1000).toISOString(), lastPosition: "Berth CP-02" },
    { id: "v3", name: "OMSKIY-86", cargo: "Cement in Big Bags", tonnage: 2500, status: "At Sea", etaPort: "Astrakhan", eta: new Date(Date.now() + 72*3600*1000).toISOString(), lastPosition: "Caspian mid-lane" },
  ] as VesselT[],
};

const LS_KEY = "mwv-status-app"; // demo storage
const CFG_KEY = "mwv-firebase-config"; // firebase config storage

// ---- Config helpers (no process.env used) ----
function loadFirebaseConfig(): (FirebaseConfig & { orgKey: string }) | null {
  try {
    const g: any = (globalThis as any);
    if (g && g.__FIREBASE && g.__FIREBASE.apiKey) {
      return { apiKey: g.__FIREBASE.apiKey, authDomain: g.__FIREBASE.authDomain, projectId: g.__FIREBASE.projectId, orgKey: g.__FIREBASE.orgKey || "default" };
    }
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}
function saveFirebaseConfig(cfg: FirebaseConfig & { orgKey: string }) { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }
function clearFirebaseConfig() { localStorage.removeItem(CFG_KEY); }

function ensureFirebase(): { db: Firestore; auth: Auth } | null {
  const cfg = loadFirebaseConfig();
  if (!cfg) return null;
  const apps = getApps();
  const app: FirebaseApp = apps.length ? apps[0]! : initializeApp({ apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId });
  return { db: getFirestore(app), auth: getAuth(app) };
}

// ---- Cloud paths (per-team via orgKey) ----
function colRefs(db: Firestore, orgKey: string) {
  return {
    W: collection(db, `orgs/${orgKey}/warehouses`),
    V: collection(db, `orgs/${orgKey}/vessels`),
    H: collection(db, `orgs/${orgKey}/healthchecks`),
  };
}

export default function App() {
  const [mode, setMode] = useState<Mode>("demo");
  const [warehouses, setWarehouses] = useState<WarehouseT[]>([]);
  const [vessels, setVessels] = useState<VesselT[]>([]);
  const [tab, setTab] = useState("warehouses");
  const [query, setQuery] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [orgKey, setOrgKey] = useState<string>(loadFirebaseConfig()?.orgKey || "default");
  const [db, setDb] = useState<Firestore | null>(null);
  const [auth, setAuth] = useState<Auth | null>(null);

  // --- Boot: choose demo by default; if Firebase config present, try cloud ---
  useEffect(() => {
    // load demo data immediately
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        setWarehouses(parsed.warehouses || SAMPLE_DATA.warehouses);
        setVessels(parsed.vessels || SAMPLE_DATA.vessels);
      } else {
        setWarehouses(SAMPLE_DATA.warehouses);
        setVessels(SAMPLE_DATA.vessels);
      }
    } catch {
      setWarehouses(SAMPLE_DATA.warehouses);
      setVessels(SAMPLE_DATA.vessels);
    }

    const f = ensureFirebase();
    if (f) {
      setDb(f.db); setAuth(f.auth);
      const cfg = loadFirebaseConfig();
      setOrgKey(cfg?.orgKey || "default");
      // watch auth; switch to cloud mode only when signed in
      const unsub = onAuthStateChanged(f.auth, (u) => {
        setUser(u);
        if (u) setMode("cloud"); else setMode("demo");
      });
      return () => unsub();
    }
  }, []);

  // --- Persist demo data locally ---
  useEffect(() => {
    if (mode === "demo") {
      localStorage.setItem(LS_KEY, JSON.stringify({ warehouses, vessels }));
    }
  }, [mode, warehouses, vessels]);

  // --- Cloud realtime sync when in cloud mode & db ready ---
  useEffect(() => {
    if (mode !== "cloud" || !db) return;
    const cfg = loadFirebaseConfig();
    if (!cfg) return;
    const { W, V } = colRefs(db, cfg.orgKey || "default");

    const unsubW = onSnapshot(fsQuery(W, orderBy("name")), (snap) => {
      const arr = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as WarehouseT[];
      setWarehouses(arr);
    });
    const unsubV = onSnapshot(fsQuery(V, orderBy("name")), (snap) => {
      const arr = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as VesselT[];
      setVessels(arr);
    });
    return () => { unsubW(); unsubV(); };
  }, [mode, db, orgKey]);

  const filteredWarehouses = useMemo(() => {
    const q = query.toLowerCase();
    return warehouses.filter((w) => w.name.toLowerCase().includes(q) || w.location.toLowerCase().includes(q) || w.status.toLowerCase().includes(q));
  }, [warehouses, query]);

  const filteredVessels = useMemo(() => {
    const q = query.toLowerCase();
    return vessels.filter((v) => v.name.toLowerCase().includes(q) || v.cargo.toLowerCase().includes(q) || (v.etaPort?.toLowerCase() || "").includes(q) || v.status.toLowerCase().includes(q));
  }, [vessels, query]);

  // ---- CRUD: dispatch to demo(localStorage) or cloud(Firestore) ----
  const createWarehouse = async (w: Omit<WarehouseT, "id">) => {
    if (mode === "demo") {
      setWarehouses((p) => [{ ...w, id: crypto.randomUUID(), lastUpdate: new Date().toISOString() }, ...p]);
      return;
    }
    if (!db) return;
    const { W } = colRefs(db, orgKey);
    await addDoc(W, { ...w, lastUpdate: new Date().toISOString(), createdAt: serverTimestamp() });
  };
  const updateWarehouse = async (w: WarehouseT) => {
    if (mode === "demo") {
      setWarehouses((p) => p.map((x) => (x.id === w.id ? { ...w, lastUpdate: new Date().toISOString() } : x)));
      return;
    }
    if (!db) return;
    await updateDoc(doc(db, `orgs/${orgKey}/warehouses/${w.id}`), { ...w, lastUpdate: new Date().toISOString() });
  };
  const deleteWarehouse = async (id: string) => {
    if (mode === "demo") { setWarehouses((p) => p.filter((x) => x.id !== id)); return; }
    if (!db) return;
    await deleteDoc(doc(db, `orgs/${orgKey}/warehouses/${id}`));
  };

  const createVessel = async (v: Omit<VesselT, "id">) => {
    if (mode === "demo") { setVessels((p) => [{ ...v, id: crypto.randomUUID() }, ...p]); return; }
    if (!db) return;
    const { V } = colRefs(db, orgKey);
    await addDoc(V, { ...v, createdAt: serverTimestamp() });
  };
  const updateVessel = async (v: VesselT) => {
    if (mode === "demo") { setVessels((p) => p.map((x) => (x.id === v.id ? { ...v } : x))); return; }
    if (!db) return;
    await updateDoc(doc(db, `orgs/${orgKey}/vessels/${v.id}`), { ...v });
  };
  const deleteVessel = async (id: string) => {
    if (mode === "demo") { setVessels((p) => p.filter((x) => x.id !== id)); return; }
    if (!db) return;
    await deleteDoc(doc(db, `orgs/${orgKey}/vessels/${id}`));
  };

  // ---- UI helpers ----
  const StatusBadge = ({ s }: { s: WarehouseT["status"] | VesselT["status"] }) => {
    const color = s === "OK" ? "bg-green-100 text-green-700" : s === "Full" ? "bg-blue-100 text-blue-700" : s === "Critical" ? "bg-red-100 text-red-700" : s === "Closed" ? "bg-zinc-200 text-zinc-700" : s === "At Sea" ? "bg-indigo-100 text-indigo-700" : s === "Loading" ? "bg-amber-100 text-amber-700" : s === "Discharging" ? "bg-emerald-100 text-emerald-700" : s === "Anchored" ? "bg-cyan-100 text-cyan-700" : "bg-rose-100 text-rose-700"; // Delayed
    return <Badge className={`rounded-full px-3 ${color}`}>{s}</Badge>;
  };
  const Progress = ({ value }: { value: number }) => (
    <div className="w-full h-2 bg-zinc-200 rounded-full overflow-hidden"><div className="h-full bg-zinc-900 transition-all" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>
  );

  const ModeBadge = () => (
    <Badge className={`ml-2 ${mode === 'cloud' ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-100 text-zinc-700'}`}>{mode === 'cloud' ? 'Cloud (secure)' : 'Demo (local)'}</Badge>
  );

  return (
    <div className="min-h-screen w-full bg-white text-zinc-900">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white/80 backdrop-blur border-b border-zinc-200 p-3 flex items-center gap-2">
        <div className="flex items-center gap-2 font-semibold text-lg">
          <Ship className="w-5 h-5" />
          <span>Ops Status</span>
          <ModeBadge />
        </div>
        <div className="ml-auto flex items-center gap-2 w-full max-w-md">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <Input className="pl-9 pr-3" placeholder="Search warehouses, vessels, cargo, port..." value={query} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)} />
          </div>
          <Button variant={editMode ? "default" : "secondary"} onClick={() => setEditMode((v) => !v)}>
            {editMode ? <Save className="w-4 h-4 mr-2" /> : <Edit className="w-4 h-4 mr-2" />}
            {editMode ? "Done" : "Edit"}
          </Button>
          <Button variant="ghost" onClick={() => setSettingsOpen(true)} title="Settings"><Settings className="w-5 h-5"/></Button>
        </div>
      </header>

      {/* Tabs */}
      <div className="p-3">
        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList className="grid grid-cols-3 w-full">
            <TabsTrigger value="warehouses">Warehouses</TabsTrigger>
            <TabsTrigger value="vessels">Vessels</TabsTrigger>
            <TabsTrigger value="tests">Tests</TabsTrigger>
          </TabsList>

          {/* Warehouses Tab */}
          <TabsContent value="warehouses" className="mt-3 space-y-3">
            <AddWarehouse onAdd={(w) => createWarehouse(w)} />
            {filteredWarehouses.map((w) => (
              <Card key={w.id} className="rounded-2xl shadow-sm border-zinc-200">
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-xl bg-zinc-100"><WIcon className="w-5 h-5"/></div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold text-base truncate">{w.name}</h3>
                        <StatusBadge s={w.status} />
                      </div>
                      <div className="mt-1 text-sm text-zinc-600 flex items-center gap-2">
                        <MapPin className="w-4 h-4" /> {w.location}
                      </div>
                      <div className="mt-3 flex items-center gap-3">
                        <Progress value={pct(w.usedTons, w.capacityTons)} />
                        <div className="text-sm tabular-nums whitespace-nowrap">{w.usedTons.toLocaleString()} / {w.capacityTons.toLocaleString()} t</div>
                      </div>
                      <div className="mt-2 text-xs text-zinc-500">Last update: {fmtDate(w.lastUpdate)}</div>
                    </div>
                    {editMode && (
                      <EditWarehouse warehouse={w} onSave={updateWarehouse} onDelete={() => deleteWarehouse(w.id)} />
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
            {filteredWarehouses.length === 0 && (<EmptyState title="No warehouses found" subtitle={mode === 'cloud' ? 'Add a new one.' : 'Try clearing the search or add a new one.'} />)}
          </TabsContent>

          {/* Vessels Tab */}
          <TabsContent value="vessels" className="mt-3 space-y-3">
            <AddVessel onAdd={(v) => createVessel(v)} />
            {filteredVessels.map((v) => (
              <Card key={v.id} className="rounded-2xl shadow-sm border-zinc-200">
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-xl bg-zinc-100"><Ship className="w-5 h-5"/></div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold text-base truncate">{v.name}</h3>
                        <StatusBadge s={v.status} />
                      </div>
                      <div className="mt-1 text-sm text-zinc-600 flex items-center gap-3 flex-wrap">
                        <span className="flex items-center gap-1"><MapPin className="w-4 h-4"/> {v.etaPort || "–"}</span>
                        <span className="flex items-center gap-1"><Timer className="w-4 h-4"/> ETA: {fmtDate(v.eta)}</span>
                      </div>
                      <div className="mt-2 text-sm text-zinc-700">Cargo: {v.cargo} · {v.tonnage.toLocaleString()} t</div>
                      <div className="mt-2 text-xs text-zinc-500">Last position: {v.lastPosition || "–"}</div>
                    </div>
                    {editMode && (
                      <EditVessel vessel={v} onSave={updateVessel} onDelete={() => deleteVessel(v.id)} />
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
            {filteredVessels.length === 0 && (<EmptyState title="No vessels found" subtitle={mode === 'cloud' ? 'Add a vessel to begin tracking.' : 'Try clearing the search or add a new one.'} />)}
          </TabsContent>

          {/* Tests Tab */}
          <TabsContent value="tests" className="mt-3 space-y-3">
            <TestsPanel mode={mode} db={db} onOpenSettings={() => setSettingsOpen(true)} />
          </TabsContent>
        </Tabs>

        <div className="pt-10 pb-20 text-center text-xs text-zinc-500">
          {mode === 'cloud' ? 'Data syncs via Firebase Firestore · Google Sign‑In protected' : 'Demo mode · Data is stored locally on this device'}
        </div>
      </div>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(o) => {
          setSettingsOpen(o);
          if (!o) {
            const f = ensureFirebase();
            if (f) { setDb(f.db); setAuth(f.auth); const cfg = loadFirebaseConfig(); setOrgKey(cfg?.orgKey || 'default'); }
          }
        }}
        auth={auth}
        user={user}
        onSignedIn={(u) => { setUser(u); setMode("cloud"); }}
        onSignedOut={() => { setUser(null); setMode("demo"); }}
      />
    </div>
  );
}

function EmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="text-center py-12">
      <div className="mx-auto w-12 h-12 rounded-2xl bg-zinc-100 flex items-center justify-center"><RefreshCw className="w-5 h-5 text-zinc-500" /></div>
      <div className="mt-3 font-medium">{title}</div>
      <div className="text-sm text-zinc-600">{subtitle}</div>
    </div>
  );
}

function AddWarehouse({ onAdd }: { onAdd: (w: Omit<WarehouseT, 'id'>) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Omit<WarehouseT, 'id'>>({ name: '', location: '', capacityTons: 0, usedTons: 0, status: 'OK', lastUpdate: new Date().toISOString() });
  const create = async () => { if (!draft.name.trim()) return; await onAdd({ ...draft, lastUpdate: new Date().toISOString() }); setOpen(false); setDraft({ name: '', location: '', capacityTons: 0, usedTons: 0, status: 'OK', lastUpdate: new Date().toISOString() }); };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button className="w-full rounded-2xl" variant="secondary"><Plus className="w-4 h-4 mr-2"/> Add Warehouse</Button></DialogTrigger>
      <DialogContent className="rounded-2xl p-4">
        <DialogHeader><DialogTitle>Add Warehouse</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Name" value={draft.name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, name: e.target.value })} />
          <Input placeholder="Location" value={draft.location} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, location: e.target.value })} />
          <div className="grid grid-cols-2 gap-2">
            <Input type="number" placeholder="Capacity (t)" value={draft.capacityTons} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, capacityTons: Number(e.target.value || 0) })} />
            <Input type="number" placeholder="Used (t)" value={draft.usedTons} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, usedTons: Number(e.target.value || 0) })} />
          </div>
          <Select value={draft.status} onValueChange={(v: string) => setDraft({ ...draft, status: v as WarehouseT['status'] })}>
            <SelectTrigger><SelectValue placeholder="Status"/></SelectTrigger>
            <SelectContent>
              <SelectItem value="OK">OK</SelectItem>
              <SelectItem value="Full">Full</SelectItem>
              <SelectItem value="Critical">Critical</SelectItem>
              <SelectItem value="Closed">Closed</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={create} className="w-full">Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EditWarehouse({ warehouse, onSave, onDelete }: { warehouse: WarehouseT; onSave: (w: WarehouseT) => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<WarehouseT>(warehouse);
  useEffect(() => setDraft(warehouse), [warehouse]);
  const save = async () => { await onSave({ ...draft, lastUpdate: new Date().toISOString() }); setOpen(false); };
  return (
    <>
      <Button size="icon" variant="ghost" onClick={() => setOpen(true)} className="rounded-xl"><Edit className="w-4 h-4" /></Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="rounded-t-3xl p-4 max-h-[80vh] overflow-y-auto">
          <SheetHeader><SheetTitle>Edit Warehouse</SheetTitle><SheetDescription>Update capacity, usage, and status.</SheetDescription></SheetHeader>
          <div className="space-y-3 mt-2">
            <Input placeholder="Name" value={draft.name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, name: e.target.value })} />
            <Input placeholder="Location" value={draft.location} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, location: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <Input type="number" placeholder="Capacity (t)" value={draft.capacityTons} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, capacityTons: Number(e.target.value || 0) })} />
              <Input type="number" placeholder="Used (t)" value={draft.usedTons} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, usedTons: Number(e.target.value || 0) })} />
            </div>
            <Select value={draft.status} onValueChange={(v: string) => setDraft({ ...draft, status: v as WarehouseT['status'] })}>
              <SelectTrigger><SelectValue placeholder="Status"/></SelectTrigger>
              <SelectContent>
                <SelectItem value="OK">OK</SelectItem>
                <SelectItem value="Full">Full</SelectItem>
                <SelectItem value="Critical">Critical</SelectItem>
                <SelectItem value="Closed">Closed</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex gap-2 pt-2">
              <Button className="flex-1" onClick={save}><Save className="w-4 h-4 mr-2"/>Save</Button>
              <Button className="flex-1" variant="secondary" onClick={() => setOpen(false)}><X className="w-4 h-4 mr-2"/>Cancel</Button>
              <Button className="flex-1" variant="destructive" onClick={onDelete}>Delete</Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function AddVessel({ onAdd }: { onAdd: (v: Omit<VesselT, 'id'>) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Omit<VesselT, 'id'>>({ name: '', cargo: '', tonnage: 0, status: 'At Sea', etaPort: '', eta: new Date().toISOString(), lastPosition: '' });
  const create = async () => { if (!draft.name.trim()) return; await onAdd({ ...draft }); setOpen(false); setDraft({ name: '', cargo: '', tonnage: 0, status: 'At Sea', etaPort: '', eta: new Date().toISOString(), lastPosition: '' }); };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button className="w-full rounded-2xl" variant="secondary"><Plus className="w-4 h-4 mr-2"/> Add Vessel</Button></DialogTrigger>
      <DialogContent className="rounded-2xl p-4">
        <DialogHeader><DialogTitle>Add Vessel</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Name" value={draft.name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, name: e.target.value })} />
          <Input placeholder="Cargo" value={draft.cargo} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, cargo: e.target.value })} />
          <Input type="number" placeholder="Tonnage (t)" value={draft.tonnage} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, tonnage: Number(e.target.value || 0) })} />
          <div className="grid grid-cols-2 gap-2">
            <Input placeholder="ETA Port" value={draft.etaPort} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, etaPort: e.target.value })} />
            <Input type="datetime-local" value={draft.eta?.slice(0,16)} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, eta: new Date(e.target.value).toISOString() })} />
          </div>
          <Input placeholder="Last Position" value={draft.lastPosition} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, lastPosition: e.target.value })} />
          <Select value={draft.status} onValueChange={(v: string) => setDraft({ ...draft, status: v as VesselT['status'] })}>
            <SelectTrigger><SelectValue placeholder="Status"/></SelectTrigger>
            <SelectContent>
              <SelectItem value="At Sea">At Sea</SelectItem>
              <SelectItem value="Loading">Loading</SelectItem>
              <SelectItem value="Discharging">Discharging</SelectItem>
              <SelectItem value="Anchored">Anchored</SelectItem>
              <SelectItem value="Delayed">Delayed</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={create} className="w-full">Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EditVessel({ vessel, onSave, onDelete }: { vessel: VesselT; onSave: (v: VesselT) => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<VesselT>(vessel);
  useEffect(() => setDraft(vessel), [vessel]);
  const save = async () => { await onSave({ ...draft }); setOpen(false); };
  return (
    <>
      <Button size="icon" variant="ghost" onClick={() => setOpen(true)} className="rounded-xl"><Edit className="w-4 h-4" /></Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="rounded-t-3xl p-4 max-h-[80vh] overflow-y-auto">
          <SheetHeader><SheetTitle>Edit Vessel</SheetTitle><SheetDescription>Update status, ETA, and last position.</SheetDescription></SheetHeader>
          <div className="space-y-3 mt-2">
            <Input placeholder="Name" value={draft.name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, name: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder="Cargo" value={draft.cargo} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, cargo: e.target.value })} />
              <Input type="number" placeholder="Tonnage" value={draft.tonnage} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, tonnage: Number(e.target.value || 0) })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder="ETA Port" value={draft.etaPort} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, etaPort: e.target.value })} />
              <Input type="datetime-local" value={draft.eta?.slice(0,16)} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, eta: new Date(e.target.value).toISOString() })} />
            </div>
            <Input placeholder="Last Position" value={draft.lastPosition} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, lastPosition: e.target.value })} />
            <Select value={draft.status} onValueChange={(v: string) => setDraft({ ...draft, status: v as VesselT['status'] })}>
              <SelectTrigger><SelectValue placeholder="Status"/></SelectTrigger>
              <SelectContent>
                <SelectItem value="At Sea">At Sea</SelectItem>
                <SelectItem value="Loading">Loading</SelectItem>
                <SelectItem value="Discharging">Discharging</SelectItem>
                <SelectItem value="Anchored">Anchored</SelectItem>
                <SelectItem value="Delayed">Delayed</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex gap-2 pt-2">
              <Button className="flex-1" onClick={save}><Save className="w-4 h-4 mr-2"/>Save</Button>
              <Button className="flex-1" variant="secondary" onClick={() => setOpen(false)}><X className="w-4 h-4 mr-2"/>Cancel</Button>
              <Button className="flex-1" variant="destructive" onClick={onDelete}>Delete</Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

// -------- Settings & Tests --------
function SettingsDialog({ open, onOpenChange, auth, user, onSignedIn, onSignedOut }: { open: boolean; onOpenChange: (o: boolean) => void; auth: Auth | null; user: User | null; onSignedIn: (u: User) => void; onSignedOut: () => void; }) {
  const existing = loadFirebaseConfig();
  const [apiKey, setApiKey] = useState(existing?.apiKey || "");
  const [authDomain, setAuthDomain] = useState(existing?.authDomain || "");
  const [projectId, setProjectId] = useState(existing?.projectId || "");
  const [orgKeyInput, setOrgKeyInput] = useState(existing?.orgKey || "default");

  const save = () => { if (!apiKey || !authDomain || !projectId) return; saveFirebaseConfig({ apiKey, authDomain, projectId, orgKey: orgKeyInput }); onOpenChange(false); };
  const reset = () => { clearFirebaseConfig(); setApiKey(""); setAuthDomain(""); setProjectId(""); setOrgKeyInput("default"); };

  const doSignIn = async () => {
    const f = ensureFirebase();
    if (!f) return; // need config first
    const provider = new GoogleAuthProvider();
    const res = await signInWithPopup(f.auth, provider);
    onSignedIn(res.user);
  };
  const doSignOut = async () => { if (!auth) return; await signOut(auth); onSignedOut(); };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-2xl p-4">
        <DialogHeader><DialogTitle>Settings</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="text-sm text-zinc-700 font-medium flex items-center gap-2"><ShieldCheck className="w-4 h-4"/> Cloud (team-only) uses Google sign-in + Firestore. Leave blank to stay in Demo.</div>
          <Input placeholder="apiKey" value={apiKey} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setApiKey(e.target.value)} />
          <Input placeholder="authDomain" value={authDomain} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAuthDomain(e.target.value)} />
          <Input placeholder="projectId" value={projectId} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setProjectId(e.target.value)} />
          <Input placeholder="orgKey (team namespace, e.g. arib)" value={orgKeyInput} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOrgKeyInput(e.target.value)} />
          <div className="flex gap-2 pt-1">
            <Button className="flex-1" onClick={save}><CheckCircle2 className="w-4 h-4 mr-2"/>Save</Button>
            <Button className="flex-1" variant="secondary" onClick={() => onOpenChange(false)}><X className="w-4 h-4 mr-2"/>Close</Button>
            <Button className="flex-1" variant="destructive" onClick={reset}>Clear</Button>
          </div>
          <div className="border-t pt-3 mt-2">
            <div className="flex items-center justify-between">
              <div className="text-sm">Auth: {user ? <span className="text-emerald-700">Signed in as {user.email}</span> : <span className="text-zinc-600">Not signed in</span>}</div>
              {user ? (
                <Button variant="secondary" onClick={doSignOut}><LogOut className="w-4 h-4 mr-2"/> Sign out</Button>
              ) : (
                <Button onClick={doSignIn}><LogIn className="w-4 h-4 mr-2"/> Sign in with Google</Button>
              )}
            </div>
          </div>
          <p className="text-xs text-zinc-500">You can also inject config with <code>window.__FIREBASE = {`{ apiKey, authDomain, projectId, orgKey }`}</code> before loading this app.</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TestsPanel({ mode, db, onOpenSettings }: { mode: Mode; db: Firestore | null; onOpenSettings: () => void }) {
  const [r1, setR1] = useState("");
  const [r2, setR2] = useState("");
  const [r3, setR3] = useState("");
  const [running, setRunning] = useState(false);

  // Test 1: Config present
  const testConfig = () => {
    const cfg = loadFirebaseConfig();
    if (cfg?.apiKey && cfg?.authDomain && cfg?.projectId) setR1("PASS: Firebase config present ✔"); else setR1("FAIL: No Firebase config. Open Settings.");
  };

  // Test 2: Firestore write/read
  const testFirestore = async () => {
    setRunning(true); setR2("");
    try {
      const cfg = loadFirebaseConfig();
      if (!cfg) throw new Error("No Firebase config");
      if (!db) throw new Error("No Firestore instance (sign in)");
      const { H } = colRefs(db, cfg.orgKey || "default");
      const ref = await addDoc(H, { t: serverTimestamp(), nonce: Math.random().toString(36).slice(2) });
      const snap = await getDoc(doc(db, `orgs/${cfg.orgKey}/healthchecks/${ref.id}`));
      setR2(snap.exists() ? "PASS: Firestore write/read works ✔" : "FAIL: written doc not readable");
    } catch (e: any) {
      setR2("ERROR: " + (e?.message || String(e)));
    } finally { setRunning(false); }
  };

  // Test 3: Demo persistence (localStorage)
  const testDemoPersistence = () => {
    try {
      const key = LS_KEY + "-test";
      const payload = { t: Date.now(), rnd: Math.random() };
      localStorage.setItem(key, JSON.stringify(payload));
      const roundtrip = JSON.parse(localStorage.getItem(key) || "null");
      setR3(roundtrip && roundtrip.rnd ? "PASS: localStorage R/W works ✔" : "FAIL: could not read back test item");
      localStorage.removeItem(key);
    } catch (e: any) {
      setR3("ERROR: " + (e?.message || String(e)));
    }
  };

  return (
    <div className="space-y-3">
      <Card className="rounded-2xl shadow-sm border-zinc-200"><CardContent className="p-4 space-y-2"><div className="font-semibold">Test 1 — Config detection</div><div className="text-sm text-zinc-600">Checks that apiKey/authDomain/projectId exist (Settings or window.__FIREBASE).</div><div className="flex gap-2"><Button onClick={testConfig}>Run</Button><Button variant="secondary" onClick={onOpenSettings}>Open Settings</Button></div>{r1 && <div className="text-sm mt-1">{r1}</div>}</CardContent></Card>
      <Card className="rounded-2xl shadow-sm border-zinc-200"><CardContent className="p-4 space-y-2"><div className="font-semibold">Test 2 — Firestore connectivity</div><div className="text-sm text-zinc-600">Writes then reads a healthcheck doc in your org.</div><div className="flex gap-2"><Button onClick={testFirestore} disabled={running || mode !== 'cloud'} title={mode !== 'cloud' ? 'Sign in first (Cloud mode)' : undefined}>{running ? 'Running…' : 'Run'}</Button><Button variant="secondary" onClick={onOpenSettings}>Open Settings</Button></div>{r2 && <div className="text-sm mt-1">{r2}</div>}</CardContent></Card>
      <Card className="rounded-2xl shadow-sm border-zinc-200"><CardContent className="p-4 space-y-2"><div className="font-semibold">Test 3 — Demo persistence</div><div className="text-sm text-zinc-600">Verifies localStorage read/write (demo mode).</div><div className="flex gap-2"><Button onClick={testDemoPersistence}>Run</Button></div>{r3 && <div className="text-sm mt-1">{r3}</div>}</CardContent></Card>
      <Card className="rounded-2xl bg-amber-50 border-amber-200 text-amber-900"><CardContent className="p-4 text-sm flex items-start gap-2"><AlertTriangle className="w-4 h-4 mt-0.5"/> For team-only access: enable Google as a provider in Firebase Auth, and use Firestore Rules like below to restrict by <code>orgKey</code> and authenticated users.</CardContent></Card>
      <pre className="text-xs bg-zinc-900 text-zinc-100 rounded-xl p-3 overflow-auto">{`
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isTeam() { return request.auth != null; }
    match /orgs/{orgKey}/{document=**} {
      allow read, write: if isTeam(); // tighten to specific emails if needed
    }
  }
}
`}</pre>
    </div>
  );
}
