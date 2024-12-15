const express = require('express');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const cliProgress = require('cli-progress');
const os = require('os');
const url = require('url');
const app = express();
const port = 5000;
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const Queue = require('bull'); // Using Bull to manage background tasks like generating thumbnails

// Load the channel mapping from the JSON file
let channelMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'goes16.map.json'), 'utf8'));

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Base directory for the mounted SMB share
// POINT TO YOUR IMAGES
const baseDirectory = '/mnt/plexy/Weather/GOES'; 

// Directory to store the thumbnails if they don't already exist
const thumbnailDir = path.join(__dirname, 'thumbnails');
if (!fs.existsSync(thumbnailDir)) {
    fs.mkdirSync(thumbnailDir); // Create the directory if it doesn't exist
}

// API route to retrieve channel description
app.get('/api/description', (req, res) => {
    let channel = req.query.channel;
    
    // If the channel is enhanced, strip the "_enhanced" suffix for simplicity
    if (channel.includes('_enhanced')) {
        channel = channel.replace('_enhanced', ''); // Remove the "_enhanced" suffix
    }

    if (channelMap[channel]) {
        let description = channelMap[channel].description || "Description not available."; // Provide default message if missing

        // Append additional info for enhanced channels
        if (req.query.channel.includes('_enhanced')) {
            description += " This enhanced version may provide higher resolution images for more precise use.";
        }

        res.json({ description: description }); // Send the description as JSON
    } else {
        res.status(204).json({ error: 'Channel not found' }); // Return error if channel not found
    }
});

// API route to get the short name for a channel
app.get('/api/shortname', (req, res) => {
    let channel = req.query.channel;

    // Remove "_enhanced" suffix for consistency
    if (channel.includes('_enhanced')) {
        channel = channel.replace('_enhanced', ''); 
    }

    if (channelMap[channel]) {
        let shortname = channelMap[channel].shortname || "Shortname not available."; // Default message if missing

        // Add "(Enhanced)" to the shortname if the channel is enhanced
        if (req.query.channel.includes('_enhanced')) {
            shortname += " (Enhanced)";
        }

        res.json({ shortname: shortname });
    } else {
        res.status(204).json({ error: 'Channel not found' }); // Return error if channel not found
    }
});

// Helper function to list files and directories from a given path
async function listFiles(dirPath, extensions = null) {
    const fullPath = path.join(baseDirectory, dirPath);
    return new Promise((resolve, reject) => {
        fs.readdir(fullPath, { withFileTypes: true }, (err, entries) => {
            if (err) {
                console.error(`Error reading directory: ${fullPath}`, err);
                return reject(err);
            }

            const filteredEntries = entries
                .filter(entry => {
                    if (extensions && !entry.isDirectory()) {
                        return extensions.some(ext => entry.name.toLowerCase().endsWith(ext)); // Filter by extensions
                    }
                    return true;
                })
                .map(entry => ({
                    filename: entry.name,
                    isDirectory: entry.isDirectory(),
                    path: path.join(dirPath, entry.name),
                }));

            resolve(filteredEntries); // Return the filtered list of files and directories
        });
    });
}

// Worker thread for generating thumbnails in the background
function generateThumbnailWorker(imagePath, thumbnailPath) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, {
            workerData: { imagePath, thumbnailPath },
        });

        worker.on('message', (result) => {
            worker.terminate().catch(err => console.error('Error terminating worker:', err)); // Clean up worker after message
            resolve(result);
        });

        worker.on('error', (err) => {
            worker.terminate().catch(err => console.error('Error terminating worker:', err)); // Clean up worker on error
            reject(err);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`Worker stopped with exit code ${code}`)); // Handle worker exit with error code
            } else {
                worker.terminate().catch(err => console.error('Error terminating worker:', err)); // Clean up worker after success
            }
        });
    });
}

// Helper function to fetch or generate thumbnails, adding them to the queue if not found
async function fetchThumbnail(filePath) {
    const encodedPath = encodeURIComponent(filePath); // Encode file path to handle special characters
    const thumbnailPath = path.join(thumbnailDir, `${encodedPath}.jpg`); // Save thumbnails as .jpg
    console.log(`API Requested: ${thumbnailPath}`);

    const fullPath = path.join(baseDirectory, filePath); // Full path of the original image

    // Check if the thumbnail already exists
    if (fs.existsSync(thumbnailPath)) {
        console.log(`Thumbnail already exists for: ${filePath}`);
        return thumbnailPath; // Return existing thumbnail
    }

    console.log(`Thumbnail not found. Adding to processing queue: ${filePath}`);
    
    // Add the task to the thumbnail queue with highest priority
    await thumbnailQueue.add({
        imagePath: fullPath,
        thumbnailPath: thumbnailPath
    }, {
        priority: 1 // High priority to process requested thumbnails immediately
    });

    return thumbnailPath; // Return path (thumbnail might still be in process)
}

// Initialize the queue for thumbnail generation (using Redis for persistence)
const thumbnailQueue = new Queue('thumbnailQueue', {
    limiter: {
        groupKey: 'thumbnailQueue',
        max: 10,
        duration: 1000,
    },
    removeOnComplete: true, // Remove completed jobs automatically
});

// Process the queue in the background
thumbnailQueue.process(async (job) => {
    const { imagePath, thumbnailPath } = job.data;
    
    // Generate thumbnail using Sharp library
    try {
        await generateThumbnailWorker(imagePath, thumbnailPath);
        console.log(`Processed thumbnail for: ${imagePath}`);
        job.progress(100); // Mark job as 100% complete
    } catch (err) {
        console.error(`Error processing thumbnail for ${imagePath}`, err);
        throw new Error('Error generating thumbnail');
    }
});

// Function to reload the channel map (useful if the mapping changes)
function reloadChannelMap() {
    try {
        const newChannelMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'goes16.map.json'), 'utf8'));
        Object.assign(channelMap, newChannelMap); // Update the channelMap with the new data
        console.log('Channel map reloaded successfully');
    } catch (err) {
        console.error('Error reloading channel map:', err);
    }
}

// Decode the filenames of the generated thumbnails
function decodeThumbnailPaths() {
    // Get all .jpg files in the 'thumbnails' directory and decode the filenames
    return fs.readdirSync(thumbnailDir)
        .filter(file => file.endsWith('.jpg'))
        .map(file => decodeURIComponent(file.replace('.jpg', ''))); // Strip .jpg extension
}

// Function to check for missing thumbnails and return a list of them
async function findMissingThumbnails() {
    console.log('Checking for missing thumbnails...');
    
    const decodedThumbnails = new Set(decodeThumbnailPaths()); // Create a set of existing thumbnails for fast lookup
    const missingThumbnails = [];
    
    // Helper function to list files in a directory and its subdirectories
    async function compareDirectory(dirPath = '') {
        const files = await listFiles(dirPath, ['.jpg', '.jpeg', '.png', '.gif', '.webp']);
        for (const file of files) {
            if (file.isDirectory) {
                await compareDirectory(file.path); // Recurse into subdirectories
            } else {
                const originalImagePath = path.join(baseDirectory, file.path);
                let encodedThumbnailPath = encodeURIComponent(file.path) + '.jpg'; // Add .jpg extension for the thumbnail

                // Check if the thumbnail is missing
                if (!decodedThumbnails.has(file.path)) {
                    missingThumbnails.push(file.path); // Add to missing list if not found
                    console.log(`MISSING thumbnail for: ${originalImagePath}`);
                }
            }
        }
    }

    await compareDirectory(); // Start comparison from the root directory
    console.log(`Found ${missingThumbnails.length} files missing thumbnails.`);
    return missingThumbnails;
}

// Process the missing thumbnails and generate them
async function processMissingThumbnails() {
    try {
        const missingThumbnails = await findMissingThumbnails();
        if (missingThumbnails.length === 0) {
            console.log('All thumbnails are up to date.');
            return;
        }

        console.log(`Found ${missingThumbnails.length} missing thumbnails. Processing...`);
        const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
        progressBar.start(missingThumbnails.length, 0);

        const batchSize = os.cpus().length; // Process in batches based on CPU count
        const tasks = [];
        let processedFiles = 0;


        const existingPaths = new Set(); // To avoid duplicates

        // Add missing thumbnail jobs to the queue
        for (const filePath of missingThumbnails) {
            if (existingPaths.has(filePath)) {
                continue; // Skip already processed files
            }

            existingPaths.add(filePath); // Track processed file paths
            const fullPath = path.join(baseDirectory, filePath);
            const encodedFilePath = encodeURIComponent(filePath);
            const thumbnailPath = path.join(thumbnailDir, encodedFilePath + '.jpg');
            

            tasks.push(
                thumbnailQueue.add({ imagePath: fullPath, thumbnailPath })
                    .then(() => {
                        processedFiles++;
                        progressBar.update(processedFiles);
                    })
            );

            // Process jobs in batches
            if (tasks.length >= batchSize) {
                await Promise.all(tasks.splice(0, batchSize));
            }
        }

        // Wait for remaining jobs to finish
        await Promise.all(tasks);
        progressBar.stop();

        console.log('Missing thumbnails processed successfully.');
    } catch (err) {
        console.error('Error processing missing thumbnails:', err);
    }
}

// Periodic task to reload the channel map and process missing thumbnails every hour
setInterval(() => {
    console.log('Running periodic check for missing thumbnails...');
    processMissingThumbnails();
    reloadChannelMap();
}, 60 * 60 * 1000);

// Worker thread execution (used for processing thumbnails)
if (!isMainThread) {
    let { imagePath, thumbnailPath } = workerData;

    sharp(imagePath)
        .resize(200) // Resize the image to a thumbnail size
        .toFile(thumbnailPath)
        .then(() => parentPort.postMessage(true))
        .catch(() => parentPort.postMessage(false))
        .finally(() => {
            imagePath = null;
            thumbnailPath = null;
        });
}

// Main thread: initialize the server and start processing missing thumbnails
if (isMainThread) {
    console.log('Initializing server and processing missing thumbnails...');
    thumbnailQueue.empty(); // Empty the queue before starting fresh
    processMissingThumbnails(); // Process missing thumbnails on startup

    // API route to list files and folders
    app.get('/api/list', async (req, res) => {
        const subPath = req.query.path || '';
        console.log(`API Request: Listing files for path: ${subPath}`);
        try {
            const files = await listFiles(subPath, ['.jpg', '.jpeg', '.png', '.gif', '.webp']);
            res.json(files);
        } catch (err) {
            console.error(`Error listing files for path: ${subPath}`, err);
            res.status(500).json({ error: 'Error listing files' });
        }
    });

    // API route to fetch thumbnails
    app.get('/api/thumbnail', async (req, res) => {
        const filePath = req.query.path;
        console.log(`API Request: Fetching thumbnail for path: ${filePath}`);

        if (!filePath) {
            console.error('Error: Path parameter is required.');
            return res.status(400).json({ error: 'Path parameter is required' });
        }

        try {
            const thumbnailPath = await fetchThumbnail(filePath); // Generate or fetch existing thumbnail
            res.sendFile(thumbnailPath);
        } catch (err) {
            console.error(`Error fetching/generating thumbnail for path: ${filePath}`, err);
            res.status(500).json({ error: 'Error generating thumbnail' });
        }
    });

    // API route to download full images
    app.get('/api/download', (req, res) => {
        const filePath = req.query.path;
        console.log(`API Request: Downloading full image for path: ${filePath}`);

        if (!filePath) {
            console.error('Error: Path parameter is required for download.');
            return res.status(400).json({ error: 'Path parameter is required' });
        }

        const fullPath = path.join(baseDirectory, filePath);
        if (!fs.existsSync(fullPath)) {
            console.error(`Error: File not found for path: ${filePath}`);
            return res.status(404).json({ error: 'File not found' });
        }
        console.log(`File found. Initiating download for: ${filePath}`);
        res.download(fullPath);
    });

    // Start the Express server
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
    });
}
