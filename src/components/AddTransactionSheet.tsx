import { useEffect, useState } from "react";
import type { TxnType } from "../types";
import { useStore } from "../store/FinanceStore";
import { todayISO } from "../lib/format";
import { t } from "../lib/i18n";
import {
  Button,
  inputClass,
  labelClass,
  Segmented,
  Sheet,
} from "./ui";

export function AddTransactionSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { data, addTransaction } = useStore();
  const [type, setType] = useState<TxnType>("expense");
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState("groceries");
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState("");
  const [accountId, setAccountId] = useState("");

  // Fresh date + a default account each time the sheet opens.
  useEffect(() => {
    if (open) {
      setDate(todayISO());
      setAccountId((prev) => prev || data.accounts[0]?.id || "");
    }
  }, [open, data.accounts]);

  const cats = data.categories.filter(
    (c) => c.type === type || c.type === "both",
  );

  function changeType(t: TxnType) {
    setType(t);
    const next = data.categories.filter(
      (c) => c.type === t || c.type === "both",
    );
    if (!next.find((c) => c.id === categoryId)) {
      setCategoryId(next[0]?.id ?? "");
    }
  }

  const amt = parseFloat(amount);
  const valid = amt > 0 && !!categoryId && !!date;

  async function submit() {
    if (!valid) return;
    await addTransaction({
      type,
      amount: Math.round(amt * 100) / 100,
      categoryId,
      date,
      description: description.trim(),
      accountId: accountId || undefined,
    });
    setAmount("");
    setDescription("");
    onClose();
  }

  return (
    <Sheet open={open} onClose={onClose} title={t("Add transaction")}>
      <div className="space-y-4">
        <Segmented<TxnType>
          value={type}
          onChange={changeType}
          options={[
            { value: "expense", label: t("Expense") },
            { value: "income", label: t("Income") },
          ]}
        />

        <div className="flex items-center justify-center gap-1 py-2">
          <span className="text-3xl font-semibold text-faint">$</span>
          <input
            type="number"
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="num w-40 bg-transparent text-center text-5xl font-bold tracking-tight text-bone outline-none placeholder:text-faint"
          />
        </div>

        <div>
          <label className={labelClass}>{t("Category")}</label>
          <div className="grid grid-cols-4 gap-2">
            {cats.map((c) => {
              const active = c.id === categoryId;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCategoryId(c.id)}
                  className={`flex flex-col items-center gap-1 rounded-xl border py-2.5 transition ${
                    active
                      ? "border-accent bg-accent/15"
                      : "border-edge bg-raised"
                  }`}
                >
                  <span className="text-xl">{c.icon}</span>
                  <span className="text-[11px] leading-tight text-taupe">
                    {t(c.name)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {data.accounts.length > 0 && (
          <div>
            <label className={labelClass}>{t("From account")}</label>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className={inputClass}
            >
              {data.accounts.map((a) => (
                <option key={a.id} value={a.id} className="bg-tile">
                  {a.name} ····{a.last4}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>{t("Date")}</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>{t("Note")}</label>
            <input
              type="text"
              placeholder={t("Optional")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>

        <Button
          onClick={submit}
          disabled={!valid}
          className="w-full"
        >
          {t("Save {kind}", {
            kind: type === "income" ? t("income") : t("expense"),
          })}
        </Button>
      </div>
    </Sheet>
  );
}
