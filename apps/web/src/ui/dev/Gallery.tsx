/**
 * Every component on one page, for checking against the system board
 * (~/orrama-redesign/mockups/out/system-light.html). Served at /dev/ui by the dev server only:
 * main.tsx loads it behind import.meta.env.DEV, so a production bundle has no trace of it.
 */
import { useRef, useState, type ReactNode } from "react";
import {
  Avatar,
  AVATAR_NAMES,
  Bar,
  Button,
  Card,
  Checkbox,
  Chip,
  DeadlineChip,
  Dialog,
  EmptyState,
  Field,
  Group,
  HeadMark,
  Icon,
  ICON_NAMES,
  Input,
  Kbd,
  Menu,
  Module,
  NameLink,
  Notice,
  Orr,
  ORR_POSES,
  OrramaLogo,
  OrramaMark,
  OrramaWordmark,
  PageHeader,
  Palette,
  Progress,
  ProgressRing,
  RadioGroup,
  Ring,
  Row,
  RowList,
  SearchField,
  Segmented,
  Select,
  Sheet,
  Skeleton,
  Square,
  Status,
  Switch,
  Tabs,
  Textarea,
  toast,
  Toaster,
} from "../index.js";

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    <h2 style={{ margin: "8px 0 0", fontSize: 22, fontWeight: 750 }}>{title}</h2>
    {children}
  </section>
);
const Line = ({ children }: { children: ReactNode }) => <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>{children}</div>;

export function Gallery() {
  const [dark, setDark] = useState(document.documentElement.dataset.theme === "dark");
  const [tab, setTab] = useState<"overview" | "timeline" | "documents" | "todo">("overview");
  const [scale, setScale] = useState<"lanes" | "hours">("lanes");
  const [sw, setSw] = useState(true);
  const [radio, setRadio] = useState<"light" | "dark" | "system">("light");
  const [open, setOpen] = useState<null | "dialog" | "sheet" | "palette" | "menu">(null);
  const [sheet, setSheet] = useState(false);
  const [pose, setPose] = useState(0);
  const menuAt = useRef<HTMLButtonElement>(null);
  const flip = () => {
    const next = !dark;
    document.documentElement.dataset.theme = next ? "dark" : "light";
    setDark(next);
  };
  return (
    <div className="ui" style={{ minHeight: "100%", padding: "28px 40px 80px", display: "flex", flexDirection: "column", gap: 28, maxWidth: 1240 }}>
      <PageHeader
        title="Orrama · components"
        meta="dev only · /dev/ui"
        crumbs={[{ label: "Orrama", href: "/" }, { label: "Design system" }]}
        actions={
          <Button icon={dark ? "sun" : "moon"} onClick={flip}>
            {dark ? "Light" : "Dark"}
          </Button>
        }
      />

      <Section title="1 · Buttons">
        <Line>
          <Button kind="solid" icon="plus">New</Button>
          <Button>Default</Button>
          <Button kind="quiet">Quiet</Button>
          <Button size="sm">Small</Button>
          <Button icon="search" aria-label="Find" tip="Find · ⌘K" />
          <Button size="sm" kind="quiet" icon="dots" aria-label="More" />
          <Button danger>Delete</Button>
          <Button orr>Book it</Button>
          <Button disabled>Disabled</Button>
        </Line>
      </Section>

      <Section title="2 · Text tabs, segmented switch">
        <Tabs label="Project" value={tab} onChange={setTab} items={[{ id: "overview", label: "Overview" }, { id: "timeline", label: "Timeline" }, { id: "documents", label: "Documents", count: 6 }, { id: "todo", label: "To-do", count: 14 }]} />
        <Segmented label="Show the week as" value={scale} onChange={setScale} items={[{ id: "lanes", label: "Lanes" }, { id: "hours", label: "Hours" }]} />
      </Section>

      <Section title="7–9 · Checkbox, chips, rings">
        <Line>
          <Checkbox state="open" label="Open" />
          <Checkbox state="progress" label="In progress" />
          <Checkbox state="blocked" label="Blocked" />
          <Checkbox state="done" label="Done" />
          <Chip dot="var(--c1)">Work</Chip>
          <Chip dot="var(--c3)" on>School</Chip>
          <Chip dot="var(--c2)">Personal</Chip>
          <DeadlineChip>Key deadline</DeadlineChip>
          <DeadlineChip small>Research plan · Mon 19</DeadlineChip>
          <Status value="on track" />
          <Status value="at risk" />
          <Status value="paused" />
        </Line>
        <Line>
          <Ring name="Ines Vermaat" />
          <Ring name="Bas de Wit" small />
          <Square name="Kade Social" />
          <Square name="Westerdok" small />
          <ProgressRing value={0.34} label="34% done" />
          <ProgressRing value={0.82} size={40} />
          <div style={{ width: 220 }}>
            <Bar value={0.6} marker={0.62} label="60% of a typical month" />
          </div>
          <Kbd>⌘K</Kbd>
          <Kbd>c</Kbd>
        </Line>
        <p style={{ margin: 0 }}>
          Both wait on <NameLink href="/people/thijs-brouwer">Thijs Brouwer</NameLink>, and you meet tomorrow at 15:00.
        </p>
      </Section>

      <Section title="5–6 · Module and rows">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}>
          <Module title="Due" titleHref="/planning" count="5" link={{ label: "Planning →", href: "/planning" }}>
            <Group late count={2}>
              Late
            </Group>
            <RowList label="Late">
              <Row lead={<Checkbox state="open" label="Ask Thijs" />} title="Ask Thijs Brouwer to sign the data agreement" meta="Graduation thesis" trailing="3 days" late onOpen={() => toast("Opened")} />
              <Row lead={<Checkbox state="blocked" label="Pull reach data" />} title="Pull 3 years of reach data" meta="blocked by the data agreement" trailing="4 days" late onOpen={() => {}} />
            </RowList>
            <Group count={3}>Today</Group>
            <RowList label="Today">
              <Row lead={<Checkbox state="progress" label="Draft chapter 3" />} title="Draft chapter 3" meta="Graduation thesis" trailing="14:00" hover={<Button size="sm" kind="quiet" icon="calendar" aria-label="Plan it" />} onOpen={() => {}} />
              <Row lead={<Ring name="Ines Vermaat" small />} title="Ines Vermaat" meta="supervises Graduation thesis" trailing="Fri 9 Oct" onOpen={() => {}} />
              <Row lead={<Square name="Kade Social" small />} title="Calculated fields: engagement rate, CPM and reach per 1,000 followers for every channel" titleAttr="Calculated fields: engagement rate, CPM and reach per 1,000 followers for every channel" meta="Reporting dashboard" trailing="Sun" onOpen={() => {}} />
            </RowList>
          </Module>
          <Card>
            <div style={{ padding: "14px 18px" }}>
              <EmptyState pose="sit" title="An open week." text="12 tasks in your notes have no date yet." actions={<Button size="sm">Pick some for this week</Button>} />
            </div>
          </Card>
        </div>
      </Section>

      <Section title="18 · Fields">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, maxWidth: 820 }}>
          <Field label="Name" help="As the rail and your Orr show it.">
            <Input defaultValue="Jules" />
          </Field>
          <Field label="Email" error="That isn't an email address.">
            <Input defaultValue="jules@" />
          </Field>
          <Field label="Model">
            <Select defaultValue="b">
              <option value="a">ChatGPT plan</option>
              <option value="b">An API key</option>
            </Select>
          </Field>
          <Field label="Find">
            <SearchField label="Find" placeholder="People, projects, notes…" />
          </Field>
          <Field label="How Orr should work for you">
            <Textarea defaultValue="Plan my mornings for writing." />
          </Field>
          <div className="field">
            <span className="lbl">Show reviews and templates</span>
            <Switch label="Show reviews and templates" checked={sw} onChange={setSw} />
          </div>
          <RadioGroup
            label="Theme"
            value={radio}
            onChange={setRadio}
            options={[
              { id: "light", label: "Light" },
              { id: "dark", label: "Dark" },
              { id: "system", label: "Match this device", help: "This device only." },
            ]}
          />
        </div>
      </Section>

      <Section title="24–25 · Empty, loading, errors">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
          <Card>
            <div style={{ padding: "14px 18px" }}>
              <Progress title="Reading 312 notes…" done="184 done" value={0.59} note="People and projects appear as they're found." />
            </div>
          </Card>
          <Card>
            <div style={{ padding: "14px 18px" }}>
              <Skeleton rows={3} />
            </div>
          </Card>
          <Notice title="Couldn't reach Gmail." text="The app password may have changed. Mail you already have is still here." actions={<><Button size="sm">Retry</Button><Button size="sm" kind="quiet">Settings → Mail</Button></>} />
          <Notice ok title="Saved." text="Your Orr is victOrr now." />
        </div>
      </Section>

      <Section title="21–23 · Overlays">
        <Line>
          <Button onClick={() => setOpen("dialog")}>Dialog</Button>
          <Button onClick={() => setSheet(true)}>Sheet</Button>
          <Button onClick={() => setOpen("palette")}>Palette</Button>
          <Button ref={menuAt} icon="chev-d" onClick={() => setOpen("menu")}>
            Menu
          </Button>
          <Button onClick={() => toast("Moved to Friday", { action: { label: "Undo", run: () => toast("Back on Thursday") } })}>Toast</Button>
        </Line>
        {open === "dialog" && (
          <Dialog title="Delete Atlas?" onClose={() => setOpen(null)} actions={<><Button onClick={() => setOpen(null)}>Keep it</Button><Button danger onClick={() => setOpen(null)}>Delete</Button></>}>
            <p>The note stays in your folder; the project leaves the board.</p>
          </Dialog>
        )}
        {sheet && (
          <Sheet title="Draft chapter 3" onClose={() => setSheet(false)}>
            <p>Graduation thesis · due Fri 16 Oct</p>
            <Button onClick={() => setOpen("dialog")}>A dialog over the sheet</Button>
          </Sheet>
        )}
        {open === "palette" && (
          <Palette label="Find" onClose={() => setOpen(null)}>
            <div style={{ padding: 12 }}>
              <SearchField label="Find" autoFocus placeholder="Find anything" />
            </div>
          </Palette>
        )}
        {open === "menu" && (
          <Menu
            anchor={menuAt}
            label="Status"
            onClose={() => setOpen(null)}
            items={[{ label: "on track", onSelect: () => {}, checked: true }, { label: "at risk", onSelect: () => {}, checked: false }, "-", { label: "Archive", onSelect: () => {}, danger: true }]}
          />
        )}
      </Section>

      <Section title="10–12 · Orr, your Orr, his mark">
        <Line>
          <Button onClick={() => setPose((p) => (p + 1) % ORR_POSES.length)}>Next pose (cross-fade)</Button>
          <span className="q3">{ORR_POSES[pose]}</span>
        </Line>
        <div style={{ display: "flex", gap: 28, alignItems: "flex-end", borderBottom: "2px solid var(--ink)", padding: "0 12px" }}>
          <Orr pose={ORR_POSES[pose]} size={112} />
          <Orr pose="sit" size={64} />
          <Orr pose="telescope" size={40} />
          <Orr pose="sit" size={16} />
          <HeadMark size={22} />
          <HeadMark size={16} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 10, alignItems: "end" }}>
          {ORR_POSES.map((p) => (
            <div key={p} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, borderBottom: "1.5px solid var(--ink-3)", paddingTop: 10 }}>
              <Orr pose={p} size={74} />
              <span className="q3" style={{ fontSize: 12 }}>
                {p}
              </span>
            </div>
          ))}
        </div>
        <Line>
          {AVATAR_NAMES.map((a) => (
            <span key={a.id} title={`${a.name} · ${a.prop}`}>
              <Avatar name={a.id} size={52} />
            </span>
          ))}
          <Avatar name="victorr" size={96} />
          <Avatar name="victorr" size={38} />
          <Avatar name="victorr" size={24} />
          <Avatar name="basalt" size={38} label="An old rock face, now Orriginal" />
        </Line>
        <Line>
          <Avatar name="orrpheus" size={112} full />
          <Avatar name="snorre" size={112} full />
        </Line>
      </Section>

      <Section title="The logo">
        <Line>
          <OrramaMark height={64} />
          <OrramaWordmark height={32} />
          <OrramaLogo height={120} />
        </Line>
      </Section>

      <Section title={`Icons (${ICON_NAMES.length})`}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: 8 }}>
          {ICON_NAMES.map((n) => (
            <div key={n} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: 8, color: "var(--ink-2)" }}>
              <Icon name={n} />
              <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{n}</span>
            </div>
          ))}
        </div>
      </Section>
      <Toaster />
    </div>
  );
}
