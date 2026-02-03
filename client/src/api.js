// client/src/api.js
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8081";

const api = axios.create({
    baseURL: API_URL,
});

// shto token-in te çdo kërkesë
api.interceptors.request.use((cfg) => {
    const t = localStorage.getItem("token");
    if (t) cfg.headers.Authorization = `Bearer ${t}`;
    return cfg;
});

// ===== Files / PDFs =====
export const ApiFiles = {
    // PDF i kërkesës
    getPdf(id) {
        return api.get(`/requests/${id}/pdf`, { responseType: "blob" });
    },

    // Ngarko foto (≤5MB, kontrollohet në UI)
    uploadAttachment(id, file) {
        const form = new FormData();
        form.append("file", file);
        return api.post(`/requests/${id}/attachment`, form, {
            headers: { "Content-Type": "multipart/form-data" },
        });
    },

    // Merre foton e ngarkuar
    getAttachment(id) {
        return api.get(`/requests/${id}/attachment`, { responseType: "blob" });
    },

    // Hap ose shkarko një Blob
    openBlob(data, filename = "file", download = false) {
        const blob = new Blob([data]);
        const url = URL.createObjectURL(blob);
        if (download) {
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } else {
            window.open(url, "_blank", "noopener");
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        }
    },
};

export default api;
