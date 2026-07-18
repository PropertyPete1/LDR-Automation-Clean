import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { Settings2, Plus, Pencil, Trash2, Zap } from "lucide-react";

export default function AgentRegistry() {
  const { user } = useAuth();
  const { data: agents, isLoading, error, refetch } = trpc.agentRegistry.list.useQuery(undefined, {
    retry: false,
  });
  const toggleActive = trpc.agentRegistry.toggleActive.useMutation({
    onSuccess: () => { refetch(); toast.success("Agent status updated"); },
    onError: (err) => toast.error(err.message),
  });
  const deleteAgent = trpc.agentRegistry.delete.useMutation({
    onSuccess: () => { refetch(); toast.success("Agent deleted"); },
    onError: (err) => toast.error(err.message),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [editAgent, setEditAgent] = useState<typeof agents extends (infer T)[] | undefined ? T | null : never>(null);

  // Admin gating
  if (user && user.role !== "admin") {
    return (
      <div className="p-6 flex flex-col items-center justify-center min-h-[60vh] text-center">
        <Settings2 className="h-12 w-12 text-slate-300 mb-4" />
        <h2 className="text-xl font-semibold text-slate-700">Access Restricted</h2>
        <p className="text-sm text-slate-500 mt-2">The Agent Registry is only available to admin users.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center gap-3">
          <Settings2 className="h-6 w-6 text-amber-500" />
          <h1 className="text-2xl font-bold text-slate-900">Agent Registry</h1>
        </div>
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-16 bg-slate-100 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 flex flex-col items-center justify-center min-h-[60vh] text-center">
        <Settings2 className="h-12 w-12 text-red-300 mb-4" />
        <h2 className="text-xl font-semibold text-red-700">Failed to Load Registry</h2>
        <p className="text-sm text-slate-500 mt-2">{error.message}</p>
        <Button variant="outline" className="mt-4" onClick={() => refetch()}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Settings2 className="h-6 w-6 text-amber-500" />
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Agent Registry</h1>
            <p className="text-sm text-slate-500">Manage engine-driven bot agents. Toggle active to enable/disable.</p>
          </div>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
              Add Agent
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Add New Agent</DialogTitle>
            </DialogHeader>
            <CreateAgentForm onSuccess={() => { setCreateOpen(false); refetch(); }} />
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-100 flex items-center justify-center">
              <Zap className="h-5 w-5 text-emerald-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{agents?.filter(a => a.engineActive).length ?? 0}</p>
              <p className="text-xs text-slate-500">Engine Active</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center">
              <Settings2 className="h-5 w-5 text-slate-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{agents?.filter(a => !a.engineActive).length ?? 0}</p>
              <p className="text-xs text-slate-500">Legacy / Inactive</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center">
              <Settings2 className="h-5 w-5 text-amber-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{agents?.length ?? 0}</p>
              <p className="text-xs text-slate-500">Total Registered</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">All Registered Agents</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bot</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>FUB ID</TableHead>
                <TableHead>Engine Active</TableHead>
                <TableHead>Intro Sent</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents?.map(agent => (
                <TableRow key={agent.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: agent.accentColor }}
                      />
                      <span className="font-medium text-slate-900">{agent.botName}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {agent.agentFirstName} {agent.agentLastName}
                  </TableCell>
                  <TableCell className="text-sm text-slate-500">{agent.agentEmail}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{agent.fubUserId}</Badge>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={agent.engineActive}
                      onCheckedChange={(checked) => {
                        toggleActive.mutate({ id: agent.id, active: checked });
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    {agent.introSentAt ? (
                      <Badge variant="secondary" className="text-xs">
                        {new Date(agent.introSentAt).toLocaleDateString()}
                      </Badge>
                    ) : (
                      <span className="text-xs text-slate-400">Pending</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditAgent(agent)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-500 hover:text-red-700"
                        onClick={() => {
                          if (confirm(`Delete ${agent.botName}?`)) {
                            deleteAgent.mutate({ id: agent.id });
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      {editAgent && (
        <Dialog open={!!editAgent} onOpenChange={(open) => { if (!open) setEditAgent(null); }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Edit {editAgent.botName}</DialogTitle>
            </DialogHeader>
            <EditAgentForm agent={editAgent} onSuccess={() => { setEditAgent(null); refetch(); }} />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ─── Create Form ────────────────────────────────────────────────────────────────

function CreateAgentForm({ onSuccess }: { onSuccess: () => void }) {
  const createAgent = trpc.agentRegistry.create.useMutation({
    onSuccess: () => { toast.success("Agent created"); onSuccess(); },
    onError: (err) => toast.error(err.message),
  });

  const [form, setForm] = useState({
    botSlug: "",
    botName: "",
    agentFirstName: "",
    agentLastName: "",
    agentEmail: "",
    fubUserId: "",
    powerQueueName: "",
    accentColor: "#ea580c",
    headerGradient: "linear-gradient(135deg,#7c2d12 0%,#ea580c 60%,#fb923c 100%)",
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createAgent.mutate({
      ...form,
      fubUserId: parseInt(form.fubUserId, 10),
      powerQueueName: form.powerQueueName || null,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Bot Slug</Label>
          <Input placeholder="jason" value={form.botSlug} onChange={e => setForm(f => ({ ...f, botSlug: e.target.value }))} required />
        </div>
        <div className="space-y-2">
          <Label>Bot Name</Label>
          <Input placeholder="Jason's Lifestyle Bot" value={form.botName} onChange={e => setForm(f => ({ ...f, botName: e.target.value }))} required />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>First Name</Label>
          <Input placeholder="Jason" value={form.agentFirstName} onChange={e => setForm(f => ({ ...f, agentFirstName: e.target.value }))} required />
        </div>
        <div className="space-y-2">
          <Label>Last Name</Label>
          <Input placeholder="Perez" value={form.agentLastName} onChange={e => setForm(f => ({ ...f, agentLastName: e.target.value }))} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Email</Label>
          <Input type="email" placeholder="jason@lifestyledesignrealty.com" value={form.agentEmail} onChange={e => setForm(f => ({ ...f, agentEmail: e.target.value }))} required />
        </div>
        <div className="space-y-2">
          <Label>FUB User ID</Label>
          <Input type="number" placeholder="37" value={form.fubUserId} onChange={e => setForm(f => ({ ...f, fubUserId: e.target.value }))} required />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Power Queue Name</Label>
          <Input placeholder="Jason" value={form.powerQueueName} onChange={e => setForm(f => ({ ...f, powerQueueName: e.target.value }))} />
        </div>
        <div className="space-y-2">
          <Label>Accent Color</Label>
          <div className="flex gap-2">
            <Input type="color" value={form.accentColor} onChange={e => setForm(f => ({ ...f, accentColor: e.target.value }))} className="w-12 h-9 p-1" />
            <Input value={form.accentColor} onChange={e => setForm(f => ({ ...f, accentColor: e.target.value }))} className="flex-1" />
          </div>
        </div>
      </div>
      <Button type="submit" className="w-full" disabled={createAgent.isPending}>
        {createAgent.isPending ? "Creating..." : "Create Agent"}
      </Button>
    </form>
  );
}

// ─── Edit Form ──────────────────────────────────────────────────────────────────

function EditAgentForm({ agent, onSuccess }: { agent: { id: number; botName: string; agentFirstName: string; agentLastName: string; agentEmail: string; fubUserId: number; powerQueueName: string | null; accentColor: string; headerGradient: string }; onSuccess: () => void }) {
  const updateAgent = trpc.agentRegistry.update.useMutation({
    onSuccess: () => { toast.success("Agent updated"); onSuccess(); },
    onError: (err) => toast.error(err.message),
  });

  const [form, setForm] = useState({
    botName: agent.botName,
    agentFirstName: agent.agentFirstName,
    agentLastName: agent.agentLastName,
    agentEmail: agent.agentEmail,
    fubUserId: String(agent.fubUserId),
    powerQueueName: agent.powerQueueName ?? "",
    accentColor: agent.accentColor,
    headerGradient: agent.headerGradient,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateAgent.mutate({
      id: agent.id,
      ...form,
      fubUserId: parseInt(form.fubUserId, 10),
      powerQueueName: form.powerQueueName || null,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Bot Name</Label>
          <Input value={form.botName} onChange={e => setForm(f => ({ ...f, botName: e.target.value }))} required />
        </div>
        <div className="space-y-2">
          <Label>First Name</Label>
          <Input value={form.agentFirstName} onChange={e => setForm(f => ({ ...f, agentFirstName: e.target.value }))} required />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Last Name</Label>
          <Input value={form.agentLastName} onChange={e => setForm(f => ({ ...f, agentLastName: e.target.value }))} />
        </div>
        <div className="space-y-2">
          <Label>Email</Label>
          <Input type="email" value={form.agentEmail} onChange={e => setForm(f => ({ ...f, agentEmail: e.target.value }))} required />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>FUB User ID</Label>
          <Input type="number" value={form.fubUserId} onChange={e => setForm(f => ({ ...f, fubUserId: e.target.value }))} required />
        </div>
        <div className="space-y-2">
          <Label>Power Queue Name</Label>
          <Input value={form.powerQueueName} onChange={e => setForm(f => ({ ...f, powerQueueName: e.target.value }))} />
        </div>
      </div>
      <div className="space-y-2">
        <Label>Accent Color</Label>
        <div className="flex gap-2">
          <Input type="color" value={form.accentColor} onChange={e => setForm(f => ({ ...f, accentColor: e.target.value }))} className="w-12 h-9 p-1" />
          <Input value={form.accentColor} onChange={e => setForm(f => ({ ...f, accentColor: e.target.value }))} className="flex-1" />
        </div>
      </div>
      <Button type="submit" className="w-full" disabled={updateAgent.isPending}>
        {updateAgent.isPending ? "Saving..." : "Save Changes"}
      </Button>
    </form>
  );
}
