import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Zap, WifiOff, RefreshCw, BarChart3, TrendingDown, CheckCircle, Settings, Save, Brain, Mail, MessageSquare, Plus, Check } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { 
    getFirestore, doc, setDoc, onSnapshot, 
    setLogLevel, collection, addDoc, updateDoc, query 
} from 'firebase/firestore';

// --- IMPORTANT: Global variables for THIS environment ONLY ---
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// --- Helper function to load configuration based on environment ---
const loadFirebaseConfig = () => {
    if (typeof __firebase_config !== 'undefined') {
        try {
            // NOTE: __firebase_config is injected at build time for security.
            return JSON.parse(__firebase_config);
        } catch (e) {
            console.error("Failed to parse __firebase_config:", e);
            return null;
        }
    }
    // Fallback configuration (using mock data for security/demo purposes)
    return {
        apiKey: 'AIzaSyBojL7EEqYKE5-JEG5N2PRfymHfAgi9p1o',
        authDomain: 'proactive-resolution-app.firebaseapp.com',
        projectId: 'proactive-resolution-app',
        storageBucket: 'proactive-resolution-app.firebasestorage.app',
        messagingSenderId: '48189015397',
        appId: '1:48189015397:web:0045015ebd42e41442cd8c',
    };
};

// --- Gemini API Configuration ---
const GEMINI_API_KEY = "AIzaSyBpxXTgbRwlwNNLKI9Fh3pZUJQKiC_ErFE"; // *** IMPORTANT: Replace with your actual Gemini API key. ***
const GEMINI_MODEL = "gemini-2.5-flash-preview-05-20";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;


//Generic utility function to call the Gemini API with exponential backoff.
const callGeminiAPI = async (payload, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(GEMINI_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                if (response.status === 429 && i < retries - 1) {
                    const delay = Math.pow(2, i) * 1000;
                    console.warn(`Rate limit hit. Retrying in ${delay / 1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue; 
                }
                throw new Error(`API call failed with status: ${response.status} - ${await response.text()}`);
            }

            const result = await response.json();
            const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error("API response was empty or malformed.");
            
            return text;

        } catch (error) {
            console.error("Gemini API error:", error);
            if (i === retries - 1) throw error; 
        }
    }
};


// --- Utility and Data Logic ---

const generateTerminalId = (index) => `T${String(1000 + index).padStart(4, '0')}`;

/**
 * Simulates incoming terminal data, introducing intentional anomalies.
 */
const simulateTerminalData = (count = 10) => {
    const data = [];
    for (let i = 0; i < count; i++) {
        const id = generateTerminalId(i);
        let transactions = Math.floor(Math.random() * 500) + 50;
        let errors = Math.floor(Math.random() * (transactions * 0.05)); 
        let status = 'Operational';
        let connectivity = Math.random() < 0.95 ? 'Online' : 'Offline';

        if (i === 1) { 
            transactions = 0;
            errors = 0;
            status = 'Critical: Outage';
            connectivity = 'Offline';
        } else if (i === 4) { 
            transactions = 350;
            errors = 100;
            status = 'Warning: High Errors';
        } else if (i === 7) { 
            transactions = Math.floor(Math.random() * 20) + 1; 
            status = 'Warning: Low Volume';
        } else if (Math.random() < 0.05) { 
            connectivity = 'Lagging';
            errors += 5;
        }

        const errorRate = transactions > 0 ? (errors / transactions) * 100 : errors > 0 ? 100 : 0;

        data.push({
            id,
            merchantName: `Merchant A${i + 1}`,
            transactions,
            errors,
            errorRate: parseFloat(errorRate.toFixed(2)),
            connectivity,
            status,
            lastUpdate: new Date().toLocaleTimeString(),
        });
    }
    return data;
};

/**
 * Core logic: Checks data for pre-defined anomaly thresholds.
 */
const checkForAnomalies = (terminals, thresholds) => {
    const alerts = [];
    if (!terminals || !thresholds) return alerts; // Safety check
    const { errorRateLimit, lowVolumeLimit } = thresholds;

    terminals.forEach(terminal => {
        if (terminal.transactions === 0 && terminal.connectivity === 'Offline') {
            alerts.push({
                type: 'Critical',
                terminalId: terminal.id,
                merchantName: terminal.merchantName,
                message: 'Complete service outage detected (0 transactions, Offline). **Immediate Proactive Action Required.**',
                Icon: Zap, 
                data: terminal 
            });
        }
        else if (terminal.errorRate > errorRateLimit) {
            alerts.push({
                type: 'Warning',
                terminalId: terminal.id,
                merchantName: terminal.merchantName,
                message: `Abnormally high error rate (${terminal.errorRate}%) detected. Exceeds limit of ${errorRateLimit}%.`,
                Icon: TrendingDown, 
                data: terminal 
            });
        }
        else if (terminal.transactions < lowVolumeLimit && terminal.connectivity === 'Online' && terminal.transactions > 0) {
            alerts.push({
                type: 'Info',
                terminalId: terminal.id,
                merchantName: terminal.merchantName,
                message: `Unusually low transaction volume (${terminal.transactions} sales). Below threshold of ${lowVolumeLimit}.`,
                Icon: BarChart3, 
                data: terminal 
            });
        }
    });

    return alerts;
};

// --- Custom Hook for System Logic ---

const useProactiveSystem = (terminalCount, db, userId) => {
    const [terminalData, setTerminalData] = useState([]);
    const [tickets, setTickets] = useState([]); 
    const [isLoading, setIsLoading] = useState(false);
    const [lastUpdated, setLastUpdated] = useState(new Date());
    const [thresholds, setThresholds] = useState({ errorRateLimit: 15, lowVolumeLimit: 20 });
    const [isConfigLoading, setIsConfigLoading] = useState(true);
    const [isTicketsLoading, setIsTicketsLoading] = useState(true);

    // handleGenerateMockTicket defined first to avoid ReferenceError
    const handleGenerateMockTicket = useCallback(async (ticketsCollectionRef, isInitial) => {
        if (!ticketsCollectionRef || terminalData.length === 0) return;
        
        const availableTerminals = terminalData.filter(t => t.status !== 'Critical: Outage');
        if (availableTerminals.length === 0) return;
        const targetTerminal = availableTerminals[Math.floor(Math.random() * availableTerminals.length)];

        const mockMessages = [
            `My payment machine ${targetTerminal.id} keeps freezing during transactions. We've had 5 failures in the last hour.`,
            `The card reader at Merchant ${targetTerminal.merchantName} is slow. Customers are complaining about the delay in processing.`,
            `I rebooted Terminal ${targetTerminal.id} but it's still showing connection issues. Please help ASAP.`,
            `I received an email about high error rates on my terminal. I need a technician to call me.`,
        ];
        
        const newMessage = {
            terminalId: targetTerminal.id,
            merchantName: targetTerminal.merchantName,
            message: mockMessages[Math.floor(Math.random() * mockMessages.length)],
            status: 'Pending',
            createdAt: new Date(), 
        };

        try {
            await addDoc(ticketsCollectionRef, newMessage);
            if (!isInitial) console.log("Mock ticket created.");
        } catch (e) {
            console.error("Error adding mock ticket:", e);
        }
    }, [terminalData]);


    // 1. Fetch Terminal Data (Simulation)
    const fetchData = useCallback(() => {
        setIsLoading(true);
        setTimeout(() => { 
            const newTerminalData = simulateTerminalData(terminalCount);
            setTerminalData(newTerminalData);
            setLastUpdated(new Date());
            setIsLoading(false);
        }, 1000);
    }, [terminalCount]);

    useEffect(() => {
        fetchData(); 
        const interval = setInterval(fetchData, 15000); 

        return () => clearInterval(interval); 
    }, [fetchData]);

    // 2. Fetch and Subscribe to Configuration Thresholds from Firestore
    useEffect(() => {
        if (!db || !userId) {
            if (!db) console.warn("Firestore client not available. Skipping config subscription.");
            setIsConfigLoading(false); 
            return; 
        }
        const configDocRef = doc(db, 'artifacts', appId, 'users', userId, 'config', 'anomaly_thresholds');

        const unsubscribe = onSnapshot(configDocRef, (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data();
                setThresholds({
                    errorRateLimit: data.errorRateLimit || 15,
                    lowVolumeLimit: data.lowVolumeLimit || 20
                });
            } else {
                const defaultThresholds = { errorRateLimit: 15, lowVolumeLimit: 20 };
                setThresholds(defaultThresholds);
                setDoc(configDocRef, defaultThresholds, { merge: true }).catch(e => console.error("Error setting default config:", e));
            }
            setIsConfigLoading(false);
        }, (error) => {
            console.error("Error subscribing to configuration:", error);
            setIsConfigLoading(false);
        });

        return () => unsubscribe(); 
    }, [db, userId]);


    // 3. Fetch and Subscribe to Merchant Tickets from Firestore
    useEffect(() => {
        if (!db || !userId) {
            if (!db) console.warn("Firestore client not available. Skipping ticket subscription.");
            setIsTicketsLoading(false);
            return;
        }
        const ticketsCollectionRef = collection(db, 'artifacts', appId, 'users', userId, 'merchant_messages');
        const q = query(ticketsCollectionRef); 

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const fetchedTickets = snapshot.docs.map(doc => {
                const data = doc.data();
                // *** Safely access nested data properties using optional chaining. ***
                const createdAt = data?.createdAt ? data.createdAt.toDate() : new Date();

                return {
                    id: doc.id,
                    ...data,
                    createdAt,
                };
            });

            fetchedTickets.sort((a, b) => {
                if (a.status === 'Pending' && b.status !== 'Pending') return -1;
                if (a.status !== 'Pending' && b.status === 'Pending') return 1;
                return b.createdAt.getTime() - a.createdAt.getTime();
            });

            setTickets(fetchedTickets);
            setIsTicketsLoading(false);
        }, (error) => {
            console.error("Error subscribing to tickets:", error);
            setIsTicketsLoading(false);
        });

        const initialLoadTimeout = setTimeout(() => {
            if (!isTicketsLoading && tickets.length === 0) {
                handleGenerateMockTicket(ticketsCollectionRef, true);
            }
        }, 2000); 

        return () => {
            clearTimeout(initialLoadTimeout);
            unsubscribe(); 
        };
    }, [db, userId, handleGenerateMockTicket, isTicketsLoading, tickets.length]);


    const alerts = useMemo(() => checkForAnomalies(terminalData, thresholds), [terminalData, thresholds]);

    const kpis = useMemo(() => {
        // ***  Guard clause to prevent crash if data arrays are unexpectedly null ***
        if (!terminalData || !alerts || !tickets) {
             console.warn("KPI calculation deferred due to missing data.");
             return [];
        }

        const totalTransactions = terminalData.reduce((sum, t) => sum + t.transactions, 0);
        const totalErrors = terminalData.reduce((sum, t) => sum + t.errors, 0);
        const onlineTerminals = terminalData.filter(t => t.connectivity === 'Online').length;
        const activeAlerts = alerts.filter(a => a.type === 'Critical' || a.type === 'Warning').length;
        const pendingTickets = tickets.filter(t => t.status === 'Pending').length;

        return [
            { id: 1, title: 'Pending Merchant Tickets', value: pendingTickets, Icon: MessageSquare, color: 'text-orange-600' }, 
            { id: 2, title: 'Total Errors Detected', value: totalErrors.toLocaleString(), Icon: TrendingDown, color: 'text-red-600' },
            { id: 3, title: 'Active Proactive Alerts', value: activeAlerts, Icon: Zap, color: 'text-yellow-600' },
            { id: 4, title: 'Online Terminals', value: `${onlineTerminals}/${terminalCount}`, Icon: CheckCircle, color: 'text-green-600' },
        ];
    }, [terminalData, alerts, terminalCount, tickets]);

    return { terminalData, alerts, kpis, isLoading, lastUpdated, fetchData, thresholds, isConfigLoading, tickets, isTicketsLoading, handleGenerateMockTicket };
};

// --- Component Definitions ---

const KpiCard = ({ title, value, Icon, color }) => (
    <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-100 transition duration-300 hover:shadow-xl">
        <div className="flex items-center space-x-4">
            <div className={`p-3 rounded-full bg-opacity-10 ${color.replace('text-', 'bg-')}`}>
                <Icon className={`w-6 h-6 ${color}`} />
            </div>
            <div>
                <p className="text-sm font-medium text-gray-500 uppercase">{title}</p>
                <p className="text-3xl font-bold text-gray-800 mt-1">{value}</p>
            </div>
        </div>
    </div>
);

const LLMOutputModal = ({ title, content, onClose }) => {
    if (!content) return null;

    return (
        <div className="fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center p-4 z-50">
            <div className="bg-white w-full max-w-xl rounded-xl shadow-2xl p-6">
                <div className="flex justify-between items-center border-b pb-3 mb-4">
                    <h3 className="text-xl font-bold text-blue-700">{title}</h3>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
                        &times;
                    </button>
                </div>
                <div className="max-h-96 overflow-y-auto whitespace-pre-wrap text-gray-700">
                    {content}
                </div>
                <div className="mt-4 text-right">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
};


const AnomalyAlerts = ({ alerts, isLoading, thresholds }) => {
    const [modalContent, setModalContent] = useState(null);
    const [modalTitle, setModalTitle] = useState('');
    const [loadingAlertId, setLoadingAlertId] = useState(null);
    
    // Ensure alerts is an array before filtering
    const criticalAlerts = Array.isArray(alerts) ? alerts.filter(a => a.type === 'Critical' || a.type === 'Warning') : [];

    const handleRCA = useCallback(async (alert) => {
        if (!GEMINI_API_KEY) {
             setModalTitle('Gemini API Error');
             setModalContent('Cannot perform RCA: GEMINI_API_KEY is missing. Please configure it in your environment settings.');
             return;
        }
        setLoadingAlertId(`${alert.terminalId}-rca`);
        setModalContent(null);
        setModalTitle(`✨ RCA Suggestion for ${alert.terminalId}`);
        
        const userQuery = `Analyze this anomaly data for a payment terminal: Issue Type: ${alert.type}. Merchant: ${alert.merchantName}. Terminal ID: ${alert.terminalId}. Transactions: ${alert.data.transactions}. Errors: ${alert.data.errors}. Error Rate: ${alert.data.errorRate}%. Connectivity: ${alert.data.connectivity}. Provide a concise, highly probable Root Cause Analysis (RCA) and list the top 3 immediate next steps for the Technical Consultant. Format the output with clear headings.`;
        
        const systemPrompt = "You are a Senior Technical Consultant at a global payments company. Your task is to provide an initial, rapid assessment of a terminal anomaly based on provided metrics. Be precise and avoid generic advice.";
        
        const payload = {
            contents: [{ parts: [{ text: userQuery }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
        };

        try {
            const text = await callGeminiAPI(payload);
            setModalContent(text);
        } catch (error) {
            setModalContent(`Failed to generate RCA: ${error.message}`);
        } finally {
            setLoadingAlertId(null);
        }
    }, []);


    const handleDraftCommunication = useCallback(async (alert) => {
        if (!GEMINI_API_KEY) {
             setModalTitle('Gemini API Error');
             setModalContent('Cannot draft communication: GEMINI_API_KEY is missing. Please configure it in your environment settings.');
             return;
        }
        setLoadingAlertId(`${alert.terminalId}-draft`);
        setModalContent(null);
        setModalTitle(`✨ Draft Proactive Email for ${alert.merchantName}`);

        const userQuery = `Draft a professional, empathetic, and urgent email to the merchant, ${alert.merchantName}, regarding the following detected issue: Terminal ID: ${alert.terminalId}. Issue: ${alert.message}. Key data: Transactions=${alert.data.transactions}, Errors=${alert.data.errors}, Connectivity=${alert.data.connectivity}. The email should inform them we detected the problem, apologize for potential disruption, and ask them to perform one simple action (e.g., reboot the terminal or check the WiFi router) while we assign a technical consultant. Keep it concise and under 150 words.`;
        
        const systemPrompt = "You are a customer communications specialist for a payments company. Draft proactive alerts that are clear, professional, and focus on immediate action steps for the merchant to minimize business impact.";
        
        const payload = {
            contents: [{ parts: [{ text: userQuery }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
        };

        try {
            const text = await callGeminiAPI(payload);
            setModalContent(text);
        } catch (error) {
            setModalContent(`Failed to draft communication: ${error.message}`);
        } finally {
            setLoadingAlertId(null);
        }
    }, []);

    if (isLoading) return <div className="text-center p-8 text-gray-500">Loading Alerts...</div>;

    return (
        <div className="p-4 rounded-xl shadow-inner bg-red-50 border border-red-200 h-full overflow-y-auto">
            <h2 className="text-xl font-bold text-red-700 mb-4 flex items-center">
                <Zap className="w-5 h-5 mr-2" /> Proactive Action Required ({criticalAlerts.length})
            </h2>
            <p className="text-xs text-gray-600 mb-4">
                <strong>Based on dynamic thresholds: Error Rate</strong> &gt; {thresholds.errorRateLimit}<strong>% | Volume </strong> &lt; {thresholds.lowVolumeLimit} <strong>sales.</strong>
            </p>
            {criticalAlerts.length === 0 ? (
                <div className="text-center py-10 text-red-400">
                    <CheckCircle className="w-10 h-10 mx-auto mb-3" />
                    <p className="font-semibold">No critical anomalies detected. System is Green.</p>
                </div>
            ) : (
                <div className="space-y-4">
                    {criticalAlerts.map((alert, index) => (
                        <div key={index} className={`p-4 rounded-lg flex flex-col space-y-2 ${
                            alert.type === 'Critical' ? 'bg-red-200 border-l-4 border-red-600' : 'bg-yellow-200 border-l-4 border-yellow-600'
                        } shadow-md`}>
                            <div className="flex items-start space-x-3">
                                <alert.Icon className={`w-6 h-6 mt-1 flex-shrink-0 ${alert.type === 'Critical' ? 'text-red-700' : 'text-yellow-700'}`} />
                                <div>
                                    <p className="text-sm font-semibold text-gray-900">{alert.message}</p>
                                    <p className="text-xs text-gray-700 mt-0.5">Terminal: {alert.terminalId} | Merchant: {alert.merchantName}</p>
                                </div>
                            </div>

                            {/* LLM Powered Buttons */}
                            <div className="flex space-x-2 mt-2 pt-2 border-t border-gray-300">
                                <button 
                                    onClick={() => handleRCA(alert)}
                                    disabled={loadingAlertId === `${alert.terminalId}-rca`}
                                    className="flex items-center text-xs font-medium text-purple-700 bg-purple-300 hover:bg-purple-400 p-1.5 rounded-lg transition duration-150 disabled:opacity-50"
                                >
                                    <Brain className={`w-3 h-3 mr-1 ${loadingAlertId === `${alert.terminalId}-rca` ? 'animate-spin' : ''}`} />
                                    {loadingAlertId === `${alert.terminalId}-rca` ? 'Analyzing...' : 'Root Cause Analysis Suggestion'}
                                </button>
                                <button 
                                    onClick={() => handleDraftCommunication(alert)}
                                    disabled={loadingAlertId === `${alert.terminalId}-draft`}
                                    className="flex items-center text-xs font-medium text-blue-700 bg-blue-300 hover:bg-blue-400 p-1.5 rounded-lg transition duration-150 disabled:opacity-50"
                                >
                                    <Mail className={`w-3 h-3 mr-1 ${loadingAlertId === `${alert.terminalId}-draft` ? 'animate-spin' : ''}`} />
                                    {loadingAlertId === `${alert.terminalId}-draft` ? 'Drafting...' : 'Draft Proactive Email'}
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
            
            <LLMOutputModal 
                title={modalTitle}
                content={modalContent}
                onClose={() => setModalContent(null)}
            />
        </div>
    );
};

const ThresholdConfiguration = ({ db, userId, thresholds, isConfigLoading, onClose }) => {
    const [localThresholds, setLocalThresholds] = useState(thresholds);
    const [isSaving, setIsSaving] = useState(false);
    const [message, setMessage] = useState('');

    useEffect(() => {
        // Only update local state if the incoming thresholds change significantly
        if (thresholds.errorRateLimit !== localThresholds.errorRateLimit || thresholds.lowVolumeLimit !== localThresholds.lowVolumeLimit) {
             setLocalThresholds(thresholds);
        }
    }, [thresholds]);

    const handleSave = async () => {
        if (!db || !userId) return setMessage('Error: Database connection failed. Cannot save configuration.');

        setIsSaving(true);
        setMessage('');

        const configDocRef = doc(db, 'artifacts', appId, 'users', userId, 'config', 'anomaly_thresholds');
        
        try {
            const errorRate = Number(localThresholds.errorRateLimit);
            const lowVolume = Number(localThresholds.lowVolumeLimit);

            if (isNaN(errorRate) || isNaN(lowVolume) || errorRate < 0 || lowVolume < 0) {
                 throw new Error("Thresholds must be valid non-negative numbers.");
            }

            await setDoc(configDocRef, {
                errorRateLimit: errorRate,
                lowVolumeLimit: lowVolume
            }, { merge: true });

            setMessage('Configuration saved successfully! Dashboard alerts will update.');
            setTimeout(() => { setMessage(''); onClose(); }, 3000); 
        } catch (error) {
            console.error("Failed to save configuration:", error);
            setMessage(`Error: Failed to save. ${error.message}`);
        } finally {
            setIsSaving(false);
        }
    };

    if (isConfigLoading) {
        return (
            <div className="p-6 text-center text-gray-500">
                <Settings className="w-6 h-6 mx-auto animate-spin mb-2 text-blue-500" />
                <p>Loading Configuration...</p>
            </div>
        );
    }

    return (
        <div className="p-6">
            <h2 className="text-2xl font-bold text-blue-700 flex items-center mb-6 border-b pb-2">
                <Settings className="w-6 h-6 mr-2 text-blue-600" />
                Anomaly Detection Configuration
            </h2>
            <div className="space-y-6">
                <div>
                    <label htmlFor="errorRate" className="block text-sm font-medium text-gray-700">
                        High Error Rate Limit (%)
                    </label>
                    <input
                        id="errorRate"
                        type="number"
                        min="0"
                        value={localThresholds.errorRateLimit}
                        onChange={(e) => setLocalThresholds({ ...localThresholds, errorRateLimit: e.target.value })}
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border"
                    />
                    <p className="text-xs text-gray-500 mt-1">Triggers 'Warning' if terminal error rate exceeds this percentage.</p>
                </div>

                <div>
                    <label htmlFor="lowVolume" className="block text-sm font-medium text-gray-700">
                        Low Transaction Volume Limit (Sales)
                    </label>
                    <input
                        id="lowVolume"
                        type="number"
                        min="1"
                        value={localThresholds.lowVolumeLimit}
                        onChange={(e) => setLocalThresholds({ ...localThresholds, lowVolumeLimit: e.target.value })}
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border"
                    />
                    <p className="text-xs text-gray-500 mt-1">Triggers 'Info' alert if transactions fall below this number.</p>
                </div>
                
                <button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="w-full flex justify-center items-center py-2 px-4 border border-transparent rounded-md shadow-lg text-sm font-medium text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 transition duration-150 disabled:opacity-50"
                >
                    <Save className={`w-4 h-4 mr-2 ${isSaving ? 'animate-pulse' : ''}`} />
                    {isSaving ? 'Saving...' : 'Save Configuration'}
                </button>
                {message && (
                    <p className={`text-center text-sm font-semibold mt-3 ${message.startsWith('Error') ? 'text-red-600' : 'text-green-600'}`}>
                        {message}
                    </p>
                )}
            </div>
        </div>
    );
};

const TicketManagement = ({ db, userId, tickets, isTicketsLoading, handleGenerateMockTicket }) => {
    // Safety check for db and userId
    if (!db || !userId) {
         return (
             <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-100 text-center text-gray-500 h-full">
                 <p className='font-semibold'>Waiting for database initialization...</p>
                 <p className='text-xs mt-2 text-red-500'>Persistence disabled: Firebase configuration is missing or invalid.</p>
             </div>
         );
    }

    const ticketsCollectionRef = collection(db, 'artifacts', appId, 'users', userId, 'merchant_messages');

    const handleResolveTicket = async (ticketId) => {
        const ticketDocRef = doc(ticketsCollectionRef, ticketId);
        try {
            await updateDoc(ticketDocRef, {
                status: 'Resolved',
                resolvedAt: new Date(),
            });
        } catch (error) {
            console.error("Error resolving ticket:", error);
        }
    };

    return (
        <div className="p-4 rounded-xl shadow-lg bg-white border border-gray-100 h-full overflow-y-auto">
            <div className="flex justify-between items-center mb-4 border-b pb-2">
                <h2 className="text-xl font-bold text-gray-800 flex items-center">
                    <MessageSquare className="w-5 h-5 mr-2 text-orange-600" /> Merchant Ticket Inbox
                </h2>
                <button 
                    onClick={() => handleGenerateMockTicket(ticketsCollectionRef, false)}
                    className="flex items-center px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition shadow-md"
                >
                    <Plus className="w-3 h-3 mr-1" /> Mock New Ticket
                </button>
            </div>

            {isTicketsLoading ? (
                <div className="text-center py-10 text-gray-500">
                    <RefreshCw className="w-6 h-6 mx-auto animate-spin mb-3" />
                    Loading Tickets...
                </div>
            ) : tickets.length === 0 ? (
                <div className="text-center py-10 text-gray-400">
                    <CheckCircle className="w-10 h-10 mx-auto mb-3" />
                    <p className="font-semibold">No open tickets. Great work!</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {tickets.map((ticket) => (
                        <div 
                            key={ticket.id} 
                            className={`p-3 rounded-lg border shadow-sm ${
                                ticket.status === 'Pending' 
                                    ? 'bg-orange-50 border-orange-300' 
                                    : 'bg-green-50 border-green-300 opacity-80'
                            }`}
                        >
                            <div className="flex justify-between items-start">
                                <div>
                                    <p className="text-sm font-semibold text-gray-900">
                                        [{ticket.terminalId}] {ticket.merchantName}
                                    </p>
                                    <p className="text-xs text-gray-700 mt-1">{ticket.message}</p>
                                </div>
                                {ticket.status === 'Pending' && (
                                    <button
                                        onClick={() => handleResolveTicket(ticket.id)}
                                        className="flex-shrink-0 flex items-center px-2 py-1 ml-2 text-xs font-medium text-white bg-green-500 rounded-full hover:bg-green-600 transition"
                                        title="Mark as Resolved"
                                    >
                                        <Check className="w-3 h-3" />
                                    </button>
                                )}
                            </div>
                            <div className="mt-2 pt-2 border-t border-gray-200 flex justify-between text-xs text-gray-500">
                                <span>{ticket.createdAt.toLocaleDateString()} {ticket.createdAt.toLocaleTimeString()}</span>
                                <span className={`font-medium ${ticket.status === 'Pending' ? 'text-orange-600' : 'text-green-600'}`}>
                                    {ticket.status}
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

const TerminalStatusTable = ({ terminals, isLoading }) => {
    // Added safety check for terminals
    const displayTerminals = Array.isArray(terminals) ? terminals : [];

    if (isLoading) return (
        <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-100 text-center text-gray-500">
            <RefreshCw className="w-6 h-6 mx-auto animate-spin mb-3" />
            Loading Terminal Data...
        </div>
    );

    return (
        <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-100 overflow-x-auto">
            <h2 className="text-xl font-bold text-gray-800 mb-4">Live Terminal Metrics ({displayTerminals.length})</h2>
            <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                    <tr>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ID</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Merchant</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Txns</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Errors (%)</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Connectivity</th>
                    </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                    {displayTerminals.map((t) => (
                        <tr key={t.id} className="hover:bg-blue-50 transition duration-150">
                            <td className="px-3 py-2 whitespace-nowrap text-sm font-medium text-gray-900">{t.id}</td>
                            <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600">{t.merchantName}</td>
                            <td className="px-3 py-2 whitespace-nowrap">
                                <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                                    t.status.includes('Critical') ? 'bg-red-100 text-red-800' :
                                    t.status.includes('Warning') ? 'bg-yellow-100 text-yellow-800' :
                                    'bg-green-100 text-green-800'
                                }`}>
                                    {t.status.split(':')[0]}
                                </span>
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600">{t.transactions}</td>
                            <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600">{t.errorRate}% ({t.errors})</td>
                            <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600">{t.connectivity}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

const SettingsPanel = ({ isOpen, onClose, children }) => {
    if (!isOpen) return null;

    // The key component to prevent clicks outside of the panel is the z-index and fixed position.
    // Ensure the backdrop only renders when the panel is open.
    return (
        <div className="fixed inset-0 z-40" aria-labelledby="slide-over-title" role="dialog" aria-modal="true">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-gray-900 bg-opacity-75 transition-opacity" onClick={onClose}></div>

            {/* Panel */}
            <div className="fixed inset-y-0 right-0 max-w-full flex">
                <div className="w-screen max-w-md">
                    <div className="flex flex-col h-full bg-white shadow-xl overflow-y-scroll">
                        <div className="p-6 border-b">
                            <div className="flex items-start justify-between">
                                <h2 id="slide-over-title" className="text-lg font-medium text-gray-900">
                                    System Settings
                                </h2>
                                <div className="ml-3 h-7 flex items-center">
                                    <button 
                                        type="button" 
                                        className="bg-white rounded-md text-gray-400 hover:text-gray-500 focus:outline-none"
                                        onClick={onClose}
                                    >
                                        <span className="sr-only">Close panel</span>
                                        &times;
                                    </button>
                                </div>
                            </div>
                        </div>
                        {children}
                    </div>
                </div>
            </div>
        </div>
    );
};


// --- Main Application Component ---

export default function App() {
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false); 
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    
    // Hardcoded for simulation, as terminal data is mocked
    const terminalCount = 10; 

    // --- Firebase Initialization and Authentication ---
    useEffect(() => {
        setLogLevel('Debug');
        const firebaseConfig = loadFirebaseConfig();
        if (!firebaseConfig) {
            console.error("Firebase configuration could not be loaded. App will run in mock mode.");
            setIsAuthReady(true);
            return;
        }

        try {
            const app = initializeApp(firebaseConfig);
            const firestore = getFirestore(app);
            const authClient = getAuth(app);

            setDb(firestore);
            setAuth(authClient);

            // 1. Authenticate using the custom token if available
            const authenticate = async () => {
                try {
                    if (initialAuthToken) {
                        await signInWithCustomToken(authClient, initialAuthToken);
                        console.log("Signed in with custom token.");
                    } else {
                        await signInAnonymously(authClient);
                        console.log("Signed in anonymously.");
                    }
                } catch (e) {
                    console.error("Firebase Auth Error:", e);
                    await signInAnonymously(authClient);
                }
            };
            authenticate();

            // 2. Auth state listener (Crucial for getting userId)
            const unsubscribe = onAuthStateChanged(authClient, (user) => {
                if (user) {
                    setUserId(user.uid);
                } else {
                    setUserId(crypto.randomUUID()); // Fallback non-authenticated ID
                }
                setIsAuthReady(true);
            });

            return () => unsubscribe();

        } catch (e) {
            console.error("Firebase App Initialization Error:", e);
            setIsAuthReady(true); 
        }
    }, []); 

    // --- Custom Hook Call ---
    const { 
        terminalData, alerts, kpis, isLoading, lastUpdated, 
        fetchData, thresholds, isConfigLoading, tickets, 
        isTicketsLoading, handleGenerateMockTicket 
    } = useProactiveSystem(terminalCount, db, userId);


    return (
        <div className="min-h-screen bg-gray-50 font-sans p-4 sm:p-6 transition-all duration-300">
            <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 p-4 bg-white rounded-xl shadow-md border border-gray-100">
                <div className="flex items-center space-x-4">
                    <Zap className="w-8 h-8 text-blue-600" />
                    <div>
                        <h1 className="text-3xl font-extrabold text-gray-900">TermSense</h1>
                        <p className="text-sm text-gray-500"> Intelligent Monitoring for Payment Terminals</p>
                    </div>
                </div>
                <div className="flex items-center space-x-3 mt-4 md:mt-0">
                    <button
                        onClick={fetchData}
                        disabled={isLoading}
                        className="flex items-center px-4 py-2 text-sm font-medium text-blue-600 bg-blue-100 rounded-lg hover:bg-blue-200 transition duration-150 shadow-sm disabled:opacity-50 disabled:cursor-wait"
                        title="Force refresh of mock terminal data"
                    >
                        <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
                        {isLoading ? 'Updating...' : 'Refresh Data'}
                    </button>
                    <button
                        onClick={() => setIsSettingsOpen(true)}
                        className="p-2 text-gray-600 bg-gray-100 rounded-full hover:bg-gray-200 transition duration-150 shadow-sm"
                        title="Open Configuration Settings"
                    >
                        <Settings className="w-5 h-5" />
                    </button>
                </div>
            </header>

            {/* Status Information */}
            <div className="flex justify-between items-center text-xs text-gray-500 mb-4 px-1">
                <p>Last Updated: <span className="font-medium text-gray-700">{lastUpdated.toLocaleTimeString()}</span></p>
                {userId && (
                    <p>User ID: <span className="font-mono text-gray-700">{userId}</span></p>
                )}
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                {kpis.length > 0 ? kpis.map(kpi => (
                    <KpiCard key={kpi.id} {...kpi} />
                )) : (
                    // Display placeholders if KPIs are not yet calculated
                    Array(4).fill().map((_, i) => <div key={i} className="bg-white p-6 rounded-xl shadow-lg border border-gray-100 animate-pulse h-28"></div>)
                )}
            </div>

            {/* Main Content Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                
                {/* 1. Proactive Alerts (Takes 1/3 width) */}
                <div className="lg:col-span-1 min-h-[400px]">
                    <AnomalyAlerts 
                        alerts={alerts} 
                        isLoading={isLoading || isConfigLoading} 
                        thresholds={thresholds} 
                    />
                </div>

                {/* 2. Terminal Table & Tickets (Takes 2/3 width) */}
                <div className="lg:col-span-2 space-y-6">
                    <TerminalStatusTable terminals={terminalData} isLoading={isLoading} />
                    <TicketManagement 
                        db={db}
                        userId={userId}
                        tickets={tickets} 
                        isTicketsLoading={isTicketsLoading} 
                        handleGenerateMockTicket={handleGenerateMockTicket}
                    />
                </div>
            </div>

            {/* Settings Panel (Modal) */}
            <SettingsPanel isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)}>
                <ThresholdConfiguration 
                    db={db}
                    userId={userId}
                    thresholds={thresholds}
                    isConfigLoading={isConfigLoading}
                    onClose={() => setIsSettingsOpen(false)}
                />
            </SettingsPanel>
        </div>
    );
}