import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Login from "./pages/Login.jsx";
import Agent from "./pages/Agent.jsx";
import Approvals from "./pages/Approvals.jsx";
import Admin from "./pages/Admin.jsx";
import "./index.css";

const AuthRoute = ({ children, roles }) => {
    const token = localStorage.getItem("token");
    const role = localStorage.getItem("role");
    if (!token) return <Navigate to="/login" replace />;
    if (roles && !roles.includes(role)) return <Navigate to="/login" replace />;
    return children;
};

ReactDOM.createRoot(document.getElementById("root")).render(
    <BrowserRouter>
        <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/agent" element={<AuthRoute roles={['agent']}><Agent /></AuthRoute>} />
            <Route path="/approvals" element={<AuthRoute roles={['team_lead', 'division_manager', 'sales_director']}><Approvals /></AuthRoute>} />
            <Route path="/admin" element={<AuthRoute roles={['admin']}><Admin /></AuthRoute>} />
            <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
    </BrowserRouter>
);
