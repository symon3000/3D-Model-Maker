import React, { useState, useRef, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleGenAI, Modality, Type } from "@google/genai";
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const FAL_KEY = "da50f91d-c96c-49e9-af4d-04d3471a3953:ec20f99b08ad9c407a1ddb83f17ca1cc";
const FAL_HUNYUAN_API_URL = "https://queue.fal.run/fal-ai/hunyuan3d/v2/multi-view";

const App = () => {
    // Generator State
    const [files, setFiles] = useState<File[]>([]);
    const [isDragging, setIsDragging] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [modelUrl, setModelUrl] = useState<string | null>(null);
    const [steps, setSteps] = useState<any[]>([]);
    const [generatedImages, setGeneratedImages] = useState<any[]>([]);
    const [totalGenerationTime, setTotalGenerationTime] = useState<number | null>(null);

    // URL Input State
    const [inputMethod, setInputMethod] = useState<'upload' | 'url'>('upload');
    const [productUrl, setProductUrl] = useState('');
    const [isFetchingUrl, setIsFetchingUrl] = useState(false);
    const [urlError, setUrlError] = useState<string | null>(null);

    const viewerRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const generationId = useRef(0);
    const falCancelUrl = useRef<string | null>(null);
    const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const stepStartRef = useRef<number | null>(null);
    const generationStartRef = useRef<number | null>(null);

    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });

    const initialSteps = [
        { name: 'Generate View Images', status: 'pending', time: 0 },
        { name: 'Generate 3D Model', status: 'pending', time: 0 },
    ];

    // --- 3D Generator Functions ---
    const updateStep = (index: number, newStatus: string) => {
        if (timerIntervalRef.current) {
            clearInterval(timerIntervalRef.current);
            timerIntervalRef.current = null;
        }

        setSteps(prev => {
            const newSteps = [...prev];
            const stepToUpdate = newSteps[index];

            if (newStatus === 'loading') {
                stepStartRef.current = performance.now();
                stepToUpdate.status = 'loading';
                stepToUpdate.time = '0.00';

                timerIntervalRef.current = setInterval(() => {
                    if (stepStartRef.current === null) return;
                    const elapsed = ((performance.now() - stepStartRef.current) / 1000);
                    setSteps(currentSteps => currentSteps.map((s, i) => {
                        if (i === index && s.status === 'loading') {
                            return { ...s, time: elapsed.toFixed(2) };
                        }
                        return s;
                    }));
                }, 100);

            } else { // 'done' or 'error'
                if (stepToUpdate.status === 'loading' && stepStartRef.current) {
                     const finalTime = ((performance.now() - stepStartRef.current) / 1000).toFixed(2);
                     stepToUpdate.time = finalTime;
                }
                stepToUpdate.status = newStatus;
                stepStartRef.current = null;
            }
            return newSteps;
        });
    };

    const handleFileChange = (selectedFiles: FileList | null) => {
        if (selectedFiles) {
            const newFiles = Array.from(selectedFiles).slice(0, 3 - files.length);
            setFiles(prev => [...prev, ...newFiles]);
        }
    };

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragging(false);
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragging(false);
        handleFileChange(e.dataTransfer.files);
    };

    const removeFile = (index: number) => {
        setFiles(prev => prev.filter((_, i) => i !== index));
    };

    const fileToGenerativePart = async (file: File) => {
        const base64EncodedDataPromise = new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
            reader.readAsDataURL(file);
        });
        return {
            inlineData: { data: await base64EncodedDataPromise, mimeType: file.type },
        };
    };
    
    const handleUrlFetch = async () => {
        if (!productUrl || isFetchingUrl || files.length >= 3) return;
    
        try {
            new URL(productUrl);
        } catch (_) {
            setUrlError("Please enter a valid URL.");
            return;
        }
    
        setIsFetchingUrl(true);
        setUrlError(null);
        setError(null);
    
        try {
            // Step 1: Get image URL from product page using URL Context tool
            const findImagePrompt = `Analyze the content of the product page at ${productUrl} and return the URL of the main, high-resolution product image. The image should be on a clean background if possible. Return the image URL.`;
            
            const imageResponse = await ai.models.generateContent({
                model: "gemini-2.5-flash-lite",
                contents: [findImagePrompt],
                config: { thinkingConfig: { thinkingBudget: -1,}, tools: [{urlContext: {}}] },
            });
    
            const firstResponseText = imageResponse.text;
    
            // Step 2: Extract the URL cleanly using structured output
            const extractUrlPrompt = `From the following text, extract the image URL: "${firstResponseText}"`;
            const jsonResponse = await ai.models.generateContent({
                model: "gemini-2.5-flash-lite",
                contents: [extractUrlPrompt],
                config: {
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: Type.OBJECT,
                        properties: {
                            imageUrl: {
                                type: Type.STRING,
                                description: "The extracted image URL"
                            },
                        },
                        required: ["imageUrl"],
                    },
                },
            });
            
            const parsedJson = JSON.parse(jsonResponse.text);
            const imageUrl = parsedJson.imageUrl;
    
            if (!imageUrl) {
                throw new Error("Gemini could not find an image URL on the provided page.");
            }
    
            // Step 3: Fetch the image and convert it to a File object
            const imageFetchResponse = await fetch(imageUrl);
            if (!imageFetchResponse.ok) {
                throw new Error(`Failed to fetch the image from the extracted URL. Status: ${imageFetchResponse.status}`);
            }
            
            const blob = await imageFetchResponse.blob();
            const filename = imageUrl.substring(imageUrl.lastIndexOf('/') + 1).split('?')[0] || 'product-image.jpg';
            const imageFile = new File([blob], filename, { type: blob.type });
    
            // Step 4: Add the file to the state
            setFiles(prev => [...prev, imageFile].slice(0, 3));
            setProductUrl('');
            setInputMethod('upload'); // Switch back to see the preview
    
        } catch (e: any) {
            console.error("Failed to fetch image from URL:", e);
            setUrlError(e.message || "An unexpected error occurred while fetching the image.");
        } finally {
            setIsFetchingUrl(false);
        }
    };
    
    const downloadAsset = async (url: string, filename: string) => {
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(link.href);
        } catch (error) {
            console.error("Download failed:", error);
            setError("Failed to download asset.");
        }
    };
    
    const resizeImage = (imageUrl: string, maxSize: number = 1024): Promise<string> => {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
    
                if (!ctx) {
                    return reject(new Error('Could not get canvas context'));
                }
    
                let { width, height } = img;
    
                if (width > height) {
                    if (width > maxSize) {
                        height = Math.round((height * maxSize) / width);
                        width = maxSize;
                    }
                } else {
                    if (height > maxSize) {
                        width = Math.round((width * maxSize) / height);
                        height = maxSize;
                    }
                }
    
                canvas.width = width;
                canvas.height = height;
    
                ctx.drawImage(img, 0, 0, width, height);
    
                const resizedDataUrl = canvas.toDataURL('image/webp', 0.9);
                resolve(resizedDataUrl);
            };
            img.onerror = (err) => {
                reject(new Error('Failed to load image for resizing.'));
            };
            img.src = imageUrl;
        });
    };

    const performGeneration = async () => {
        generationId.current++;
        const currentGenerationId = generationId.current;

        try {
            updateStep(0, 'loading');
            
            const imageParts = await Promise.all(files.map(fileToGenerativePart));

            const generateSingleView = async (viewName: string) => {
                const prompt = `Using the attached image(s) as a reference, generate a single, high-resolution, photorealistic image of the object's **${viewName}**. The object must be centered on a clean, plain white background, as though it was photographed in a whitespace studio with professional lighting. Ensure the lighting is neutral and clearly shows the object's details. The final image must be a 1:1 square aspect ratio. Do not include any text, labels, or watermarks.`;
                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash-image-preview',
                    contents: { parts: [...imageParts, { text: prompt }] },
                    config: { responseModalities: [Modality.IMAGE] },
                });

                const imagePart = response.candidates?.[0]?.content?.parts?.find(part => part.inlineData);
                if (!imagePart?.inlineData) throw new Error(`Gemini failed to generate the ${viewName}.`);
                
                const url = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
                return { label: viewName.charAt(0).toUpperCase() + viewName.slice(1), url };
            };

            const viewPromises = [
                generateSingleView("front view"),
                generateSingleView("back view"),
                generateSingleView("left side view")
            ];

            const results = await Promise.all(viewPromises);
            if (generationId.current !== currentGenerationId) return;

            setGeneratedImages(results);
            updateStep(0, 'done');
            
            updateStep(1, 'loading');

            const resizePromises = results.map(img => resizeImage(img.url, 1024));
            const resizedImageUrls = await Promise.all(resizePromises);
            if (generationId.current !== currentGenerationId) return;

            const [frontResized, backResized, leftResized] = resizedImageUrls;

            const input = {
                front_image_url: frontResized,
                back_image_url: backResized,
                left_image_url: leftResized,
                textured_mesh: true,
            };

            const submitResponse = await fetch(FAL_HUNYUAN_API_URL, {
                method: 'POST',
                headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(input),
            });

            if (generationId.current !== currentGenerationId) return;
            if (!submitResponse.ok) throw new Error(`Fal.ai submission failed: ${await submitResponse.text()}`);
            const submitResult = await submitResponse.json();
            falCancelUrl.current = submitResult.cancel_url;
            const statusUrl = submitResult.status_url;

            let finalResult = null;
            while (!finalResult) {
                if (generationId.current !== currentGenerationId) return;
                const pollRes = await fetch(statusUrl, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
                const pollBody = await pollRes.json();
                
                if (pollBody.status === "COMPLETED") {
                    const resultResponse = await fetch(submitResult.response_url, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
                    const resultData = await resultResponse.json();
                    if (resultData.status === 'ERROR' || resultData.model_mesh?.url == null) {
                        throw new Error(`Generation failed: ${resultData.logs?.map((log: any) => log.message).join('\n') || 'Unknown error'}`);
                    }
                    finalResult = resultData;
                    break;
                } else if (pollBody.status === "ERROR") {
                    throw new Error(pollBody.logs?.map((log: any) => log.message).join('\n') || 'Polling error.');
                }
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
            if (generationId.current !== currentGenerationId) return;
            
            updateStep(1, 'done');
            setModelUrl(finalResult.model_mesh.url);

            if (generationStartRef.current) {
                const duration = (performance.now() - generationStartRef.current) / 1000;
                setTotalGenerationTime(duration);
                generationStartRef.current = null;
            }

        } catch (e: any) {
            if (generationId.current !== currentGenerationId) return;
            console.error("An error occurred during generation:", e);
            setError(e.message || "An unknown error occurred.");
            setSteps(prev => prev.map(s => s.status === 'loading' ? { ...s, status: 'error' } : s));
            if (generationStartRef.current) {
                generationStartRef.current = null;
            }
        } finally {
            if (generationId.current === currentGenerationId) {
                setIsLoading(false);
                falCancelUrl.current = null;
            }
        }
    };
    
    const startGeneration = () => {
        if (files.length === 0 || isLoading) return;
        resetStateForGeneration();
        generationStartRef.current = performance.now();
        performGeneration();
    };

    const rerunImageGenerationStep = async () => {
        if (falCancelUrl.current) {
            try { await fetch(falCancelUrl.current, { method: 'PUT', headers: { 'Authorization': `Key ${FAL_KEY}` } }); } 
            catch (e) { console.error("Failed to cancel fal.ai request", e); }
        }
        
        setError(null);
        setModelUrl(null);
        setSteps(initialSteps);
        setGeneratedImages([]);
        setIsLoading(true);
        setTotalGenerationTime(null);
        generationStartRef.current = performance.now();
        performGeneration();
    };

    const handleCancelGeneration = async () => {
        generationId.current++;
        if (falCancelUrl.current) {
            try { await fetch(falCancelUrl.current, { method: 'PUT', headers: { 'Authorization': `Key ${FAL_KEY}` } }); } 
            catch (e) { console.error("Failed to cancel fal.ai request", e); }
        }
        if (timerIntervalRef.current) {
            clearInterval(timerIntervalRef.current);
            timerIntervalRef.current = null;
        }
        reset();
    };
    
    const resetStateForGeneration = () => {
        setIsLoading(true);
        setError(null);
        setModelUrl(null);
        setSteps(initialSteps);
        setGeneratedImages([]);
        falCancelUrl.current = null;
        setTotalGenerationTime(null);
        generationStartRef.current = null;
    };

    const reset = () => {
        setFiles([]);
        resetStateForGeneration();
        setIsLoading(false);
        if (viewerRef.current) viewerRef.current.innerHTML = '';
        sceneRef.current = null;
    };
    
    useEffect(() => {
        return () => {
            if (timerIntervalRef.current) {
                clearInterval(timerIntervalRef.current);
            }
        };
    }, []);

    useEffect(() => {
        if (!modelUrl || !viewerRef.current) return;
    
        const currentViewer = viewerRef.current;
        currentViewer.innerHTML = ''; 
    
        const scene = new THREE.Scene();
        sceneRef.current = scene;
        scene.background = new THREE.Color(0x1e1e1e);
    
        const camera = new THREE.PerspectiveCamera(75, currentViewer.clientWidth / currentViewer.clientHeight, 0.1, 1000);
        
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(currentViewer.clientWidth, currentViewer.clientHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        currentViewer.appendChild(renderer.domElement);
    
        scene.add(new THREE.AmbientLight(0xffffff, 2));
        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 2);
        hemiLight.position.set(0, 20, 0);
        scene.add(hemiLight);
        const directionalLight1 = new THREE.DirectionalLight(0xffffff, 3);
        directionalLight1.position.set(5, 10, 7.5).normalize();
        scene.add(directionalLight1);
        const directionalLight2 = new THREE.DirectionalLight(0xffffff, 2);
        directionalLight2.position.set(-5, 10, -7.5).normalize();
        scene.add(directionalLight2);
    
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.autoRotate = true;
    
        const loader = new GLTFLoader();
        loader.load(modelUrl, (gltf) => {
            const model = gltf.scene;
            const box = new THREE.Box3().setFromObject(model);
            const size = box.getSize(new THREE.Vector3());
            const center = box.getCenter(new THREE.Vector3());
    
            model.position.x += (model.position.x - center.x);
            model.position.y += (model.position.y - center.y);
            model.position.z += (model.position.z - center.z);
    
            controls.target.copy(center);
    
            const maxDim = Math.max(size.x, size.y, size.z);
            const fov = camera.fov * (Math.PI / 180);
            let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
            cameraZ *= 2.0; // Increased multiplier to zoom out
    
            camera.position.set(center.x, center.y, center.z + cameraZ);
            camera.lookAt(center);
    
            scene.add(model);
        }, undefined, (error) => {
            console.error("An error happened during model loading:", error);
            setError('Failed to load the 3D model.');
        });
    
        const animate = () => {
            if (!sceneRef.current) return;
            requestAnimationFrame(animate);
            controls.update();
            renderer.render(scene, camera);
        };
        animate();
    
        const handleResize = () => {
            if (!currentViewer || !renderer) return;
            camera.aspect = currentViewer.clientWidth / currentViewer.clientHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(currentViewer.clientWidth, currentViewer.clientHeight);
        };
        window.addEventListener('resize', handleResize);
    
        return () => {
            window.removeEventListener('resize', handleResize);
            if(currentViewer) currentViewer.innerHTML = '';
            sceneRef.current = null;
        };
    }, [modelUrl]);
    
    const renderStatusIcon = (status: string) => {
        if (status === 'loading') return <div className="spinner"></div>;
        if (status === 'done') return <span className="step-status">✅</span>;
        if (status === 'error') return <span className="step-status">❌</span>;
        return <span className="step-status">...</span>;
    };

    const DownloadIcon = () => (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
    );

    return (
        <div className="container">
            {isLoading && !modelUrl && (
                <div className="loading-overlay">
                    <div className="loading-content">
                        <h2>Generating your model...</h2>
                        <ul className="steps-container">
                            {steps.map((step, index) => (
                                <li key={index} className={`step-item ${step.status}`}>
                                    {renderStatusIcon(step.status)}
                                    <div className="step-details">
                                        <span className="step-name">{step.name}</span>
                                        {step.status === 'loading' && <span className="step-time">Elapsed: {step.time}s</span>}
                                        {step.status === 'done' && <span className="step-time">Completed in {step.time}s</span>}
                                    </div>
                                </li>
                            ))}
                        </ul>
                         {error && <div className="error-message">{error}</div>}
                        <div className="loading-previews">
                            {generatedImages.length > 0 && (
                                <>
                                    <h3>Generated View Images (Inputs for 3D Model)</h3>
                                    <div className="preview-grid">
                                        {generatedImages.map(img => (
                                            <div key={img.label} className="preview-item-loading">
                                                <img src={img.url} alt={img.label}/>
                                                <p>{img.label}</p>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="loading-actions">
                                        <button onClick={rerunImageGenerationStep} className="secondary-button">Rerun Image Generation</button>
                                        <button onClick={handleCancelGeneration} className="secondary-button danger">Cancel & Start Over</button>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {modelUrl ? (
                <>
                    <h1>Your 3D Model is Ready!</h1>
                    <div className="result-container">
                        <div className="model-panel">
                            <div ref={viewerRef} className="model-viewer-container"></div>
                             <button onClick={() => downloadAsset(modelUrl, '3d-model.glb')} className="action-button">
                                Download 3D Model (.glb)
                            </button>
                        </div>
                        <div className="summary-panel">
                            <h2>Process Summary</h2>
                            <div className="summary-section">
                                <h3>Assets</h3>
                                <h4>Original Images</h4>
                                <div className="asset-grid">
                                    {files.map((file, i) => (
                                        <div key={i} className="asset-item">
                                            <img src={URL.createObjectURL(file)} alt={`original ${i+1}`} />
                                            <button onClick={() => downloadAsset(URL.createObjectURL(file), file.name)} className="download-button" title="Download">
                                                <DownloadIcon />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                                <hr style={{margin: '1rem 0', border: `1px solid var(--border-color)`}}/>
                                <h4>Generated Images</h4>
                                <div className="asset-grid">
                                     {generatedImages.map(img => (
                                        <div key={img.label} className="asset-item">
                                            <img src={img.url} alt={img.label}/>
                                            <p>{img.label.split(' ')[0]}</p>
                                            <button onClick={() => downloadAsset(img.url, `${img.label.replace(' ','-').toLowerCase()}.png`)} className="download-button" title="Download">
                                                <DownloadIcon />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            {totalGenerationTime !== null && (
                                <>
                                    <hr style={{margin: '0 0 1.5rem 0', border: `1px solid var(--border-color)`}}/>
                                    <div className="summary-section">
                                        <h3>Performance</h3>
                                        <p className="total-time">Total generation time: <strong>{totalGenerationTime.toFixed(2)}s</strong></p>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                     <button onClick={reset} className="action-button" style={{marginTop: '1.5rem', maxWidth:'300px', alignSelf:'center'}}>Create Another</button>
                </>
            ) : (
                <>
                    <div className="intro-header">
                        <h1>Transform Any Product to 3D</h1>
                        <p className="sub-headline">One Pic + One Click = A 3D Boost to Sales (in Seconds)</p>
                        <p>For online merchants and auctioneers, showcasing products in 3D can <a href="https://www.shopify.com/blog/3d-ecommerce" target="_blank">significantly increase customer engagement and conversion rates (94%!)</a>. In less than a minute, our tool transforms a single product image into an interactive 3D model—all with the click of a button.</p>
                    </div>
                    
                     <div className="generator-section">
                         <h2>Select Input Image(s)</h2>
                         <p className="step-subtitle">Provide a single image, and we'll take care of the rest.</p>

                        <div className="input-method-tabs">
                            <button className={`tab-button ${inputMethod === 'upload' ? 'active' : ''}`} onClick={() => setInputMethod('upload')}>
                                Upload Image File
                            </button>
                            <button className={`tab-button ${inputMethod === 'url' ? 'active' : ''}`} onClick={() => setInputMethod('url')}>
                                Fetch From Product Page (Beta)
                            </button>
                        </div>

                        {inputMethod === 'upload' ? (
                             <div
                                className={`upload-area ${isDragging ? 'drag-over' : ''}`}
                                onDragOver={handleDragOver}
                                onDragLeave={handleDragLeave}
                                onDrop={handleDrop}
                                onClick={() => document.getElementById('file-input')?.click()}
                            >
                                <p><span>Click to upload</span> or drag and drop</p>
                                <p>Up to 3 images</p>
                                <input type="file" id="file-input" multiple accept="image/*" style={{ display: 'none' }} onChange={(e) => handleFileChange(e.target.files)} />
                            </div>
                        ) : (
                            <div className="url-input-area">
                                <p>Already listed? Paste your live product page URL here to automatically extract the main image. (This Beta feature is still finicky. For best results, upload your image directly.)</p>
                                <div className="url-input-group">
                                    <input 
                                        type="url"
                                        placeholder="e.g. https://www.liveauctioneers.com/item/214360132_a-contemporary-desk-los-angeles-ca"
                                        value={productUrl}
                                        onChange={(e) => setProductUrl(e.target.value)}
                                        disabled={isFetchingUrl}
                                        aria-label="Product page URL"
                                    />
                                    <button onClick={handleUrlFetch} disabled={isFetchingUrl || !productUrl || files.length >= 3}>
                                        {isFetchingUrl ? <div className="spinner-small"></div> : 'Fetch Image'}
                                    </button>
                                </div>
                                {urlError && <div className="error-message small">{urlError}</div>}
                            </div>
                        )}
                       
                        {files.length > 0 && (
                            <div className="image-previews">
                                {files.map((file, index) => (
                                    <div key={index} className="preview-item">
                                        <img src={URL.createObjectURL(file)} alt={`preview ${index}`} />
                                        <button onClick={() => removeFile(index)} className="remove-btn" aria-label="Remove image">×</button>
                                    </div>
                                ))}
                            </div>
                        )}
                        {error && !isLoading && <div className="error-message">{error}</div>}
                        <button onClick={startGeneration} className="action-button" disabled={files.length === 0 || isLoading}>
                            Generate 3D Model
                        </button>
                     </div>
                </>
            )}
        </div>
    );
};

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);