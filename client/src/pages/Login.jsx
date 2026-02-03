import { useState } from "react";
import api from "../api";

export default function Login() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [err, setErr] = useState("");

    const submit = async (e) => {
        e.preventDefault();
        setErr("");
        try {
            const { data } = await api.post("/auth/login", { email, password });
            localStorage.setItem("token", data.token);
            localStorage.setItem("role", data.profile.role);

            if (data.profile.role === 'admin') location.href = "/admin";
            else if (data.profile.role === 'agent') location.href = "/agent";
            else location.href = "/approvals";
        } catch (ex) {
            setErr(ex.response?.data?.error || ex.message || "Login failed");
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
            <form onSubmit={submit} className="bg-white p-6 rounded-2xl shadow w-full max-w-sm space-y-3">
                <h1 className="text-xl font-semibold">Hyrje</h1>
                <input className="w-full border p-2 rounded" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
                <input className="w-full border p-2 rounded" type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} />
                {err && <div className="text-red-600 text-sm">{err}</div>}
                <button className="w-full bg-black text-white p-2 rounded-xl">Login</button>
            </form>
        </div>
    );
}
