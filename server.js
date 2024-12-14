const express = require('express');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const cliProgress = require('cli-progress');
const os = require('os');
const app = express();
const port = 5000;
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const Queue = require('bull'); // Using a job queue library like Bull for background tasks

// Load the channel mapping from the JSON file
let channelMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'goes16.map.json'), 'utf8'));

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Base directory for mounted SMB share
const baseDirectory = '/mnt/plexy/Weather/GOES';

// Directory for storing thumbnails
const thumbnailDir = path.join(__dirname, 'thumbnails');
if (!fs.existsSync(thumbnailDir)) {
    fs.mkdirSync(thumbnailDir);
}

// API route to get the description for a channel
app.get('/api/description', (req, res) => {
    let channel = req.query.channel;
    
    // Check if the channel is an enhanced version and strip the "_enhanced" part
    if (channel.includes('_enhanced')) {
        channel = channel.replace('_enhanced', ''); // Remove the "_enhanced" suffix
    }

    if (channelMap[channel]) {
        let description = channelMap[channel].description || "Description not available."; // Default message if description is missing

        // Add the enhanced explanation if the channel was originally enhanced
        if (req.query.channel.includes('_enhanced')) {
            description += " This enhanced version may provide higher resolution images for more precise use.";
        }

        res.json({
            description: description
        });
    } else {
        res.status(204).json({ error: 'Channel not found' });
    }
});

// API route to get the short name for a channel
app.get('/api/shortname', (req, res) => {
    let channel = req.query.channel;

    // Check if the channel is an enhanced version and strip the "_enhanced" part
    if (channel.includes('_enhanced')) {
        channel = channel.replace('_enhanced', ''); // Remove the "_enhanced" suffix
    }

    if (channelMap[channel]) {
        let shortname = channelMap[channel].shortname || "Shortname not available."; // Default message if shortname is missing

        // Modify the shortname if the channel was originally enhanced
        if (req.query.channel.includes('_enhanced')) {
            shortname += " (Enhanced)";
        }

        res.json({
            shortname: shortname
        });
    } else {
        res.status(204).json({ error: 'Channel not found' });
    }
});

// Helper function to list files and folders
async function listFiles(dirPath, extensions = null) {
    const fullPath = path.join(baseDirectory, dirPath);
    console.log(`Listing files in directory: ${fullPath}`);
    return new Promise((resolve, reject) => {
        fs.readdir(fullPath, { withFileTypes: true }, (err, entries) => {
            if (err) {
                console.error(`Error reading directory: ${fullPath}`, err);
                return reject(err);
            }

            const filteredEntries = entries
                .filter(entry => {
                    if (extensions && !entry.isDirectory()) {
                        return extensions.some(ext => entry.name.toLowerCase().endsWith(ext));
                    }
                    return true;
                })
                .map(entry => ({
                    filename: entry.name,
                    isDirectory: entry.isDirectory(),
                    path: path.join(dirPath, entry.name),
                }));

            resolve(filteredEntries);
        });
    });
}

// Worker thread for thumbnail generation
function generateThumbnailWorker(imagePath, thumbnailPath) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, {
            workerData: { imagePath, thumbnailPath },
        });

        worker.on('message', resolve);
        worker.on('error', reject);
        worker.on('exit', code => {
            if (code !== 0) {
                reject(new Error(`Worker stopped with exit code ${code}`));
            }
        });
    });
}

// Function to generate or fetch the thumbnail from disk
async function fetchThumbnail(filePath) {
    const thumbnailPath = path.join(thumbnailDir, encodeURIComponent(filePath) + '.jpg');
    const fullPath = path.join(baseDirectory, filePath);

    if (fs.existsSync(thumbnailPath)) {
        console.log(`Thumbnail found on disk for path: ${filePath}`);
        return thumbnailPath;
    }

    console.log(`Thumbnail not found on disk. Generating for path: ${filePath}`);
    await generateThumbnailWorker(fullPath, thumbnailPath);
    return thumbnailPath;
}

// Background job queue for thumbnail processing
const thumbnailQueue = new Queue('thumbnailQueue', {
    limiter: {
        groupKey: 'thumbnailQueue',
        max: 10,
        duration: 1000,
    },
    removeOnComplete: true,
});

// Process the job queue in a background worker
thumbnailQueue.process(async (job) => {
    const { imagePath, thumbnailPath } = job.data;
    await generateThumbnailWorker(imagePath, thumbnailPath);
    console.log(`Processed thumbnail for: ${imagePath}`);
    job.progress(100); 
});

// Function to reload the channel map
function reloadChannelMap() {
    try {
        const newChannelMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'goes16.map.json'), 'utf8'));
        Object.assign(channelMap, newChannelMap); // Update the channelMap
        console.log('Channel map reloaded successfully');
    } catch (err) {
        console.error('Error reloading channel map:', err);
    }
}

// Main thread processing logic
async function processDirectory(subPath = '', progressBar) {
    const files = await listFiles(subPath, ['.jpg', '.jpeg', '.png', '.gif', '.webp']);
    const totalFiles = files.filter(file => !file.isDirectory).length;
    let processedFiles = 0;

    progressBar.setTotal(totalFiles);

    const batchSize = Math.max(2, os.cpus().length);
    const tasks = [];

    for (const file of files) {
        if (file.isDirectory) {
            tasks.push(processDirectory(file.path, progressBar));
        } else {
            const fullPath = path.join(baseDirectory, file.path);
            const thumbnailPath = path.join(thumbnailDir, encodeURIComponent(file.path) + '.jpg');
            tasks.push(
                thumbnailQueue.add({ imagePath: fullPath, thumbnailPath })
                    .then(() => {
                        processedFiles++;
                        progressBar.update(processedFiles); 
                    })
            );
        }

        if (tasks.length >= batchSize) {
            await Promise.all(tasks.splice(0, batchSize));
        }
    }

    await Promise.all(tasks);
}

// Function to process thumbnails for all images
async function processThumbnails() {
    console.log('Starting thumbnail generation process...');
    try {
        const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
        progressBar.start(0, 0);

        await processDirectory('', progressBar);

        progressBar.stop();
        console.log('Thumbnail generation process completed.');

        // Reload channel map after processing
        reloadChannelMap();
    } catch (err) {
        console.error('Error during thumbnail generation process:', err);
    }
}

// Periodic task to reload channel map and process thumbnails every hour
setInterval(() => {
    console.log('Running periodic thumbnail check and channel map reload...');
    processThumbnails();
    reloadChannelMap();  // Reload channel map independently
}, 60 * 60 * 1000); // Every hour

// Worker thread execution
if (!isMainThread) {
    const { imagePath, thumbnailPath } = workerData;

    sharp(imagePath)
        .resize(200)
        .toFile(thumbnailPath)
        .then(() => parentPort.postMessage(true))
        .catch(() => parentPort.postMessage(false))
        .finally(() => {
            workerData = null; 
        });
}

if (isMainThread) {
    console.log('Initializing server and starting thumbnail generation on startup.');
    processThumbnails();

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
            console.error('Error: Path parameter is required for thumbnail fetch.');
            return res.status(400).json({ error: 'Path parameter is required' });
        }

        try {
            const thumbnailPath = await fetchThumbnail(filePath);
            res.sendFile(thumbnailPath);
        } catch (err) {
            console.error(`Error fetching/generating thumbnail for path: ${filePath}`, err);
            res.status(500).json({ error: 'Error generating thumbnail' });
        }
    });

    // API route to download full image
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
        console.log(`File found. Initiating download for path: ${filePath}`);
        res.download(fullPath);
    });

    // Start server
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
    });
}
