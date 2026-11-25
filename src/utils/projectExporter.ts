import {
  BuildMode,
  ProjectDatabaseConfig,
  ProjectSecret,
} from '../types/craft';
import { extractEditableCodeFiles } from './codeFileEditor';
import { createZipBlob } from './zipBuilder';

export interface ExportedProjectFile {
  path: string;
  content: string;
}

export function buildProjectExportFiles(params: {
  projectTitle: string;
  slug: string;
  mode: BuildMode;
  html: string;
  databaseConfig?: ProjectDatabaseConfig;
  secrets?: ProjectSecret[];
  includeSecrets?: boolean;
}): ExportedProjectFile[] {
  const {
    projectTitle,
    slug,
    mode,
    html,
    databaseConfig,
    secrets = [],
    includeSecrets = false,
  } = params;

  const editable = extractEditableCodeFiles(html);
  const cssFile = editable.find((f) => f.id === 'styles.css');
  const jsFile = editable.find((f) => f.id === 'app.js');
  const screenFiles = editable.filter((f) => f.kind === 'screen');

  let cleanIndexHtml = html;

  if (cssFile) {
    let replacedStyle = false;
    cleanIndexHtml = cleanIndexHtml.replace(
      /<style\b([^>]*)>[\s\S]*?<\/style>/gi,
      (full, attrs) => {
        if (/data-aicraft-safety/i.test(attrs || '')) return full;
        if (!replacedStyle) {
          replacedStyle = true;
          return '<link rel="stylesheet" href="./styles.css" />';
        }
        return '';
      }
    );
  }

  if (jsFile) {
    let replacedScript = false;
    cleanIndexHtml = cleanIndexHtml.replace(
      /<script\b([^>]*)>[\s\S]*?<\/script>/gi,
      (full, attrs) => {
        if (/data-aicraft-safety-js/i.test(attrs || '') || /\bsrc\s*=/i.test(attrs || '')) {
          return full;
        }
        const typeMatch = /\btype\s*=\s*["']([^"']+)["']/i.exec(attrs || '');
        if (typeMatch) {
          const mime = typeMatch[1].trim().toLowerCase();
          if (mime && mime !== 'text/javascript' && mime !== 'application/javascript' && mime !== 'module') {
            return full;
          }
        }
        if (!replacedScript) {
          replacedScript = true;
          return '<script src="./app.js"></script>';
        }
        return '';
      }
    );
  }

  if (includeSecrets && secrets.length > 0) {
    const envObj: Record<string, string> = {};
    for (const s of secrets) {
      if (s.key) envObj[s.key] = s.value;
    }
    const safeJson = JSON.stringify(envObj).replace(/</g, '\\u003c');
    const envScript = `<script>window.__AICRAFT_ENV__=${safeJson};window.ENV=Object.assign({},window.ENV||{},window.__AICRAFT_ENV__);</script>`;
    cleanIndexHtml = /<\/head>/i.test(cleanIndexHtml)
      ? cleanIndexHtml.replace(/<\/head>/i, `${envScript}\n</head>`)
      : `${envScript}\n${cleanIndexHtml}`;
  }

  if (!/rel=["']manifest["']/i.test(cleanIndexHtml)) {
    const manifestLink = '<link rel="manifest" href="./manifest.webmanifest" />';
    cleanIndexHtml = /<\/head>/i.test(cleanIndexHtml)
      ? cleanIndexHtml.replace(/<\/head>/i, `  ${manifestLink}\n</head>`)
      : cleanIndexHtml;
  }

  const files: ExportedProjectFile[] = [
    { path: 'index.html', content: cleanIndexHtml },
  ];

  if (cssFile) {
    files.push({ path: 'styles.css', content: cssFile.content });
  }
  if (jsFile) {
    files.push({ path: 'app.js', content: jsFile.content });
  }
  for (const scr of screenFiles) {
    files.push({ path: scr.id, content: scr.content });
  }

  const tables = databaseConfig?.tables ?? [];
  if (tables.length > 0) {
    const schemaSql = tables
      .map((t) => {
        const cols = t.columns.map((c) => {
          const sqlType =
            c.type === 'number'
              ? 'NUMERIC'
              : c.type === 'boolean'
                ? 'BOOLEAN DEFAULT false'
                : c.type === 'timestamp'
                  ? 'TIMESTAMPTZ DEFAULT now()'
                  : c.type === 'json'
                    ? "JSONB DEFAULT '{}'::jsonb"
                    : c.name === 'id'
                      ? 'TEXT PRIMARY KEY'
                      : 'TEXT';
          return `  ${c.name} ${sqlType}`;
        });
        return `CREATE TABLE IF NOT EXISTS ${t.name} (\n${cols.join(',\n')}\n);`;
      })
      .join('\n\n');
    files.push({ path: 'database/schema.sql', content: schemaSql });
  }

  files.push({
    path: 'manifest.webmanifest',
    content: JSON.stringify(
      {
        name: projectTitle,
        short_name: projectTitle.slice(0, 14),
        start_url: './index.html',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: mode === 'mobile' ? '#7A68F6' : '#8B5CF6',
      },
      null,
      2
    ),
  });

  files.push({
    path: 'package.json',
    content: JSON.stringify(
      {
        name: slug || 'aicraft-app',
        version: '1.0.0',
        private: true,
        scripts: {
          dev: 'npx serve . -l 3000',
          start: 'npx serve . -l 3000',
        },
      },
      null,
      2
    ),
  });

  files.push({
    path: 'README.md',
    content: `# ${projectTitle}\n\nGenerated with AI Craft (${mode} mode).\n\n## Run Locally\n\n\`\`\`bash\nnpx serve . -l 3000\n\`\`\`\n\n## Files\n\n${files.map((f) => `- \`${f.path}\``).join('\n')}\n- \`README.md\`\n`,
  });

  return files;
}

export function downloadProjectZip(params: {
  projectTitle: string;
  slug: string;
  mode: BuildMode;
  html: string;
  databaseConfig?: ProjectDatabaseConfig;
  secrets?: ProjectSecret[];
  includeSecrets?: boolean;
}): { fileCount: number; filename: string } {
  const files = buildProjectExportFiles(params);
  const blob = createZipBlob(files);
  const filename = `${params.slug || 'aicraft-app'}.zip`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return { fileCount: files.length, filename };
}
