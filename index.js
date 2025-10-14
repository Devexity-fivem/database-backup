const mysqldump = require('mysqldump');
const fs = require('fs').promises;
const path = require('path');
const archiver = require('archiver');
const { Webhook, MessageBuilder } = require('discord-webhook-node');
const config = require('./config.json');


const root = GetResourcePath(GetCurrentResourceName());
const backupDir = path.join(root, 'sql');


fs.mkdir(backupDir, { recursive: true }).then(() => {
    console.log(`[backup] Backup directory ready: ${backupDir}`);
}).catch(() => {
});

let backupCount = 0;
let isBackupRunning = false;

function Delay(ms) {
    return new Promise(res => setTimeout(res, ms));
}

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}


function getFileSizeInMB(filepath) {
    const stats = require('fs').statSync(filepath);
    const fileSizeInMB = stats.size / (1024 * 1024);
    return fileSizeInMB;
}


async function zipFile(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const output = require('fs').createWriteStream(outputPath);
        const archive = archiver('zip', { 
            zlib: { level: 6 } // Good balance between speed and compression
        });

        output.on('close', () => {
            const inputSize = getFileSizeInMB(inputPath);
            const outputSize = getFileSizeInMB(outputPath);
            const compressionRatio = ((1 - (outputSize / inputSize)) * 100).toFixed(1);
            console.log(`[backup] Compression: ${inputSize.toFixed(2)}MB -> ${outputSize.toFixed(2)}MB (${compressionRatio}% reduction)`);
            resolve();
        });
        
        archive.on('error', err => reject(err));
        archive.on('warning', (err) => {
            if (err.code === 'ENOENT') {
                console.warn('[backup] Archive warning:', err);
            }
        });

        archive.pipe(output);
        archive.file(inputPath, { name: path.basename(inputPath) });
        archive.finalize();
    });
}

async function cleanupFiles(filepath, zipPath) {
    try {
        await Promise.all([
            fs.unlink(filepath).catch(err => console.warn(`[backup] Failed to delete SQL:`, err)),
            fs.unlink(zipPath).catch(err => console.warn(`[backup] Failed to delete ZIP:`, err))
        ]);
        console.log(`[backup] Cleanup completed`);
    } catch (err) {
        console.warn(`[backup] Cleanup error:`, err);
    }
}

// === Optimized MySQL dump for smaller files ===
async function performBackup() {
    if (isBackupRunning) {
        console.log('[backup] Skipping - backup in progress');
        return;
    }
    
    isBackupRunning = true;
    
    try {
        backupCount++;
        const filename = `${config.database_info.database}-${timestamp()}.sql`;
        const filepath = path.join(backupDir, filename);
        const zipPath = filepath.replace('.sql', '.zip');

        console.log(`[backup] Starting backup (${backupCount})...`);

        // MySQL dump with optimizations for smaller file size
        await mysqldump({
            connection: {
                host: config.database_info.host,
                user: config.database_info.user,
                password: config.database_info.password,
                database: config.database_info.database,
            },
            dumpToFile: filepath,
            compress: false, // We handle compression separately
            mysqldumpOptions: {
                '--quick': true,
                '--single-transaction': true,
                '--skip-lock-tables': true,
                '--no-tablespaces': true,
                '--skip-comments': true, // Skip comments to reduce size
                '--compact': true, // Less verbose output
                '--skip-add-drop-table': true, // Skip DROP TABLE statements
            }
        });

        const sqlSize = getFileSizeInMB(filepath);
        console.log(`[backup] MySQL dump completed`);

        // Create compressed ZIP
        console.log(`[backup] Compressing backup...`);
        await zipFile(filepath, zipPath);

        // Check final file size
        const finalSizeMB = getFileSizeInMB(zipPath);

        // Handle Discord upload ONLY if file is small enough
        if (config.discord && config.discord.savetodiscord && config.discord.webhook) {
            if (finalSizeMB <= 8) { // Discord free tier limit
                // Start upload but don't wait for it
                uploadToDiscordBackground(zipPath, filepath, finalSizeMB).catch(err => {
                    console.error('[backup] Background upload failed:', err);
                });
                console.log(`[backup] Backup completed (uploading to Discord)`);
            } else {
                console.log(`[backup] Backup completed (file too large for Discord: ${finalSizeMB.toFixed(2)} MB)`);
                // File too large - cleanup if configured
                if (config.delete_after_upload) {
                    await cleanupFiles(filepath, zipPath);
                }
            }
        } else {
            // No Discord - cleanup immediately if needed
            if (config.delete_after_upload) {
                await cleanupFiles(filepath, zipPath);
            }
            console.log(`[backup] Backup completed`);
        }

    } catch (err) {
        console.error('[backup] Backup error:', err);
    } finally {
        isBackupRunning = false;
    }
}

// === Discord upload in background ===
async function uploadToDiscordBackground(zipPath, filepath, fileSizeMB) {
    console.log('[backup] Starting background Discord upload...');
    
    try {
        const hook = new Webhook(config.discord.webhook);
        
        // Create embed
        const embed = new MessageBuilder()
            .setAuthor('Database Backup Complete')
            .setColor(config.discord.color || '#3498db')
            .addField('Database', config.database_info.database, true)
            .addField('File', path.basename(zipPath), true)
            .addField('Size', `${fileSizeMB.toFixed(2)} MB`, true)
            .addField('Date', new Date().toLocaleString())
            .setFooter(config.discord.footer || 'Database backup')
            .setTimestamp();

        await hook.send(embed);
        
        
        await Delay(1000);
        
        await hook.sendFile(zipPath);

        console.log('[backup] Discord upload completed');

      
        if (config.delete_after_upload) {
            await cleanupFiles(filepath, zipPath);
        }
        
    } catch (discordErr) {
        console.error('[backup] Discord upload error:', discordErr);
        // If upload fails due to file size, cleanup anyway if configured
        if (config.delete_after_upload) {
            await cleanupFiles(filepath, zipPath);
        }
    }
}

// === 5-hour interval setup ===
const intervalSeconds = config.interval.time || 18000; // 18000 seconds = 5 hours
const intervalMs = intervalSeconds * 1000;

console.log(`[backup] Starting backups every 5 hours`);

// Wait 2 minutes before first backup to let server stabilize
setTimeout(() => {
    performBackup().catch(console.error);
}, 120000);

// Set interval for 5 hours
setInterval(() => {
    performBackup().catch(console.error);
}, intervalMs);