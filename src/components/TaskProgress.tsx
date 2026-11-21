import { motion } from "framer-motion";
export default function TaskProgress({ label, value }: { label: string; value: number }) {
  return (
    <div className="task" onClick={(e) => e.stopPropagation()}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--muted)", marginBottom: 5 }}>
        <span>{label}</span><span>{Math.round(value)}%</span>
      </div>
      <div className="bar">
        <motion.div className="fill" animate={{ width: `${value}%` }} transition={{ type: "spring", stiffness: 120, damping: 20 }} />
      </div>
    </div>
  );
}
