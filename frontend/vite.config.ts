import {defineConfig} from "vite";
import {copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync} from "fs";
import {join, resolve} from "path";

function copyRecursive(src: string, dest: string) {
    if (!existsSync(src)) return;
    if (statSync(src).isDirectory()) {
        if (!existsSync(dest)) mkdirSync(dest, {recursive: true});
        for (const entry of readdirSync(src)) {
            copyRecursive(join(src, entry), join(dest, entry));
        }
    } else {
        copyFileSync(src, dest);
    }
}

export default defineConfig({
    base: "./",
    build: {
        outDir: "../backend/web",
        emptyOutDir: true,
        assetsDir: ""
    },
    plugins: [
        {
            name: "copy-to-app-www",
            closeBundle() {
                const src = resolve(__dirname, "../backend/web");
                const dest = resolve(__dirname, "../app/www");
                if (existsSync(dest)) {
                    rmSync(dest, {recursive: true, force: true});
                }
                copyRecursive(src, dest);
                console.log(`\n  ✅ 已同步到 app/www\n`);
            }
        }
    ],
    server: {
        port: 5173,
        host: true,
        proxy: {
            "/api": {
                target: "http://127.0.0.1:19528",
                changeOrigin: true,
                ws: true
            }
        }
    },
    preview: {
        port: 4173,
        host: true,
        proxy: {
            "/api": {
                target: "http://127.0.0.1:19528",
                changeOrigin: true,
                ws: true
            }
        }
    }
});