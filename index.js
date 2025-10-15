// vars //
const mysqldump = require('mysqldump');
const config = require('./config.json');
const { Webhook, MessageBuilder } = require('discord-webhook-node');
const fs = require('fs');
const archiver = require('archiver');
const path = require('path');
const root = GetResourcePath(GetCurrentResourceName());
let num = 0;

// loop //
setInterval(async () => {
    try {
        num++;
        const sqlFile = path.join(root, `sql/${config.database_info.database}-${num}-${Date.now()}.sql`);
        const zipFile = sqlFile.replace('.sql', '.zip');

        // Step 1: Dump database to SQL file
        await mysqldump({
            connection: {
                host: config.database_info.host,
                user: config.database_info.user,
                password: config.database_info.password,
                database: config.database_info.database,
            },
            dumpToFile: sqlFile,
        });

        // Step 2: Zip the SQL file
        await zipFileAsync(sqlFile, zipFile);

        // Step 3: Delete original SQL to save space (optional)
        fs.unlinkSync(sqlFile);

        // Step 4: Upload to Discord
        if (config.discord.savetodiscord) {
            const hook = new Webhook(config.discord.webhook);
            const embed = new MessageBuilder()
                .setAuthor('Database Backup')
                .setColor(config.discord.color)
                .addField('Database', config.database_info.database)
                .addField('Backup File', path.basename(zipFile))
                .addField('Date', new Date().toLocaleString())
                .setFooter(config.discord.footer)
                .setTimestamp();

            await hook.send(embed);
            await hook.sendFile(zipFile);
        }

        console.log(`[Backup] Database saved & uploaded: ${zipFile}`);
    } catch (err) {
        console.error('Backup failed:', err);
    }
}, config.interval.time * 1000 * 60);

// functions //
function Delay(ms) {
    return new Promise((res) => setTimeout(res, ms));
}

function zipFileAsync(inputFile, outputFile) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputFile);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        archive.on('error', (err) => reject(err));

        archive.pipe(output);
        archive.file(inputFile, { name: path.basename(inputFile) });
        archive.finalize();
    });
}
