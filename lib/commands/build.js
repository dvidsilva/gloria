const $log = require('../utils/logger');
const S = require(`string`);
const fs = require('../utils/fs');
const fse = require('fs-extra');
const path = require('path');
const $q = require('q');
const chalk = require(`chalk`);
const fm = require('front-matter');

const Project = require('../core/project');
const project = new Project;
const root = process.cwd();

const Render = require(`../build/render`);

function copyPublicFiles (publicFolder, dest) {
    const publicFiles = project.public || [];
    fs.copySync(publicFolder, `${dest}`);
    $log.log(chalk.green(`Copied ${publicFiles.length} public files.`));
    return publicFiles;
}

/**
 * Copies public files to the destination folder, and extracts pages so they can
 * be rendered.
 * @param {Array[]} files - The list of files that resulted from fse.walk.
 * @param {string} dest - The folder where they site will be build to.
 * @param {Object} data - The metadata and info needed to parse the content.
 */
function sortFiles (files, dest, data) {
    const result = [];
    files.forEach(function (file, index) {
        if (typeof Render[file.extension] === 'function') {
            result[file.extension] = result[file.extension] ? result[file.extension] + 1 : 1;
            const content = Render.extract(file);
            if (content.fm.ignore) {
                return;
            }

            fse.ensureDirSync(`${dest}${content.destination.folder}`);
            const page = Object.assign({}, file, content.fm, {
                content: content.content,
                destination: `${dest}${content.destination.folder}${content.destination.file}`,
                data: content.fm,
                type: file.extension,
            });
            result.push(page);
            return;
        }

        if (file.path !== root) {
            $log.log(`Copying`, file.path, ` to ${dest}${file.basePath}${file.name}`);
            project.count.others++;
            fs.copySync(file.path, path.normalize(`${dest}${file.basePath}${file.name}`));
            return;
        }
    });

    return result;
}

function sortPosts (files, dest, data) {
    const posts = sortFiles(files, dest, data);
    posts.forEach((post, index, arr) => {
        post.data.layout = post.data.layout || 'post';
        const url = S(post.data.url).slugify().s;
        const category = post.data.category === undefined || post.data.category === null ?
            S(post.data.category).slugify().s : ``;
        post.url = path.normalize(`/blog/${category}/${url}`);
        arr[index] = post;
    });
    return posts;
}

function processFiles (dest, args) {
    const files = project.files || [];
    const posts = project.posts || [];

    const data = {
        site: project.config,
        args: args,
        data: {},
    };
    const results = {
        pages: [],
        posts: [],
    };

    project.styles.forEach((item) => {
        const result = Render.renderStyles(item, dest);
        fse.ensureDirSync(`${dest}/sass`);
        fse.writeFile(`${dest}${path.sep}sass${path.sep}${item.name.replace('scss', 'css')}`,
        result.css.css, (err) => {
            if (err) {throw err;}
            $log.log(`file ${root}${path.sep}sass${path.sep}${item.name} written`);
        });
    });

    project.stylus.forEach((item) => {
        const result = Render.renderStylus(item, dest);
        fse.ensureDirSync(`${dest}/stylus`);
        fse.writeFile(`${dest}${path.sep}stylus${path.sep}${item.name.replace('.styl', 'css')}`,
        result.css.css, (err) => {
            if (err) {throw err;}
            $log.log(`file ${root}${path.sep}stylus${path.sep}${item.name} written`);
        });
    });

    project.jsondata.forEach((file) => {
        const currentJSON = JSON.parse(fs.readFileSync(`${root}${file.shortPath}`, 'utf8'));
        const name = file.name.replace(/\.json$/, '');
        data.data[name] =  currentJSON;
    });

    // created a separate function to diff pages and posts Issue:12
    project.pages = sortFiles(files, dest, data);
    project.posts = sortPosts(posts, dest, data);
    data.posts = project.posts;
    project.pages.forEach((page, index) => {
        results.pages.push(Render[page.type](page, data));
    });

    project.posts.forEach((post, index) => {
        results.posts.push(Render.post(post, data));
    });

    // Wrap all the writefiles in promises and then after promise.all call console.timeEnd
    // and log info
    const promiseArray = [];
    for (const result in results) {
        results[result].forEach((page) => {
            const folder = page.destination.folder || '';
            const destination = path.normalize(`${dest}/${folder}/${page.destination.file}`);
            fse.ensureDirSync(path.normalize(`${dest}/${folder}`));

            var writeFile = $q.nfbind(fse.writeFile);
            promiseArray.push(writeFile(destination, page.content)
            .then((result) => {
                $log.log(`file ${destination} written`);
            })
            .catch(error => $log.error(error)));
        });
    };

    return $q.all(promiseArray).done(() => {
        $log.timeEnd('Build time');
        $log.log(`# of public files: ${project.public.length}`);
        $log.log(`# of pages: ${project.pages.length}`);
        $log.log(`# of posts: ${project.posts.length}`);
        $log.log(`# of sass: ${project.styles.length}`);
        $log.log(`# of stylus: ${project.stylus.length}`);
        $log.log(`# of JSON: ${project.jsondata.length}`);
    });
}

function handler (argv) {
    if (argv.silent) {
        $log.silent();
    }

    const publicFolder = `${root}${path.sep}_public`;
    const includesFolder = `${root}${path.sep}_includes`;
    const layoutsFolder = `${root}${path.sep}_layout`;
    const sassFolder = `${root}${path.sep}_sass`;
    const stylusFolder = `${root}${path.sep}_stylus`;
    const postsFolder = `${root}${path.sep}_posts`;
    const dataFolder = `${root}${path.sep}_data`;

    $log.time('Build time');

    if (S(argv.dest).include('..')) {
        $log.error(`Won't build to a parent directory, mostly security reasons.
        Happy to take a look if you open an issue.`);
        return null;
    }

    if (argv.dest.lastIndexOf('.', 0) === 0) {
        $log.error(`Won't build to itself, it breaks everything.`);
        return null;
    }

    const config = project.loadConfig(`yaml`);
    let dest = argv.dest ? argv.dest : (project.config.dest ? project.config.dest : 'site');
    project.change({ dest: dest });
    if (argv.save) {
        project.saveYAML(true, root);
    }

    dest = `${root}${path.sep}${dest}`;
    if (!config) {
        $log.error(`_config.yml not found, won't build.`);
        return null;
    }

    if (argv.clear !== false) {
        $log.log(`Clearing dest directory ${dest}.`);
        fs.emptyDirSync(dest);
    }

    // This would cause duplication when build is called
    // several times, like when serving with watch

    project.files = [];
    project.public = [];
    project.includes = [];
    project.posts = [];
    project.layouts = [];
    project.styles = [];
    project.stylus = [];
    project.jsondata = [];

    $log.log(`starting to walk the file system`);
    fse.walk(`${root}`).on('data', function (item) {
        if (S(item.path).include(dest)) {return;}

        item.isDirectory = item.stats.isDirectory();
        item.shortPath = S(item.path).chompLeft(root).s;
        item.name = path.basename(item.path);
        item.basePath = S(item.shortPath).chompRight(item.name).s;
        item.extension = path.extname(item.path);

        if (argv.git !== true && (item.shortPath.lastIndexOf(`${path.sep}.git`, 0) === 0) &&
            item.name !== `.gitignore`) {
            return;
        }

        if (item.shortPath.lastIndexOf(`${path.sep}_`, 0) === 0) {

            if (S(item.path).include(publicFolder)) {
                return project.public.push(item);
            }

            if (S(item.path).include(postsFolder) && !item.isDirectory) {
                return project.posts.push(item);
            }

            if (S(item.path).include(includesFolder) && !item.isDirectory) {
                return project.includes.push(item);
            }

            if (S(item.path).include(layoutsFolder) && !item.isDirectory) {
                return project.layouts[item.name.replace(item.extension, '')] = item;
            }

            if (S(item.path).include(sassFolder) && !(item.name.lastIndexOf(`_`, 0) === 0)) {
                return project.styles.push(item);
            }

            if (S(item.path).include(stylusFolder) && !(item.name.lastIndexOf(`_`, 0) === 0)) {
                return project.stylus.push(item);
            }

            if (S(item.path).include(dataFolder) && !item.isDirectory) {
                return project.jsondata.push(item);
            }

            return $log.log(`ignoring ${item.shortPath}`);
        }

        project.files.push(item);
    }).on('end', () => {
        fs.stat(publicFolder, (err, stats) => {
            if (!err && stats.isDirectory()) {copyPublicFiles(publicFolder, dest);}
        });

        Render.registerPartials(project.includes);
        Render.registerLayouts(project.layouts);
        processFiles(dest, argv);
    });

}

const builder = {
    dest: {
        default: ``,
        description: `Destination path or folder to build the site, by default it uses 'site'.`,
    },
    clear: {
        default: true,
        description: `When different to false, it will not
            overwrite other files in the dest folder.`,
    },
    git: {
        default: false,
        description: `By default it will ignore the .git directory.
            I don't see a reason why would you include it, but if you want to use --git=true.`,
    },
    save: {
        default: true,
        description: `By default it will save new configuration arguments in the _config file.`,
    },
    silent: {
        default: false,
        description: `Limit the amount of output to the console.`,
        alias: 's',
        type: 'boolean',
    },
};

module.exports = {
    command: `build [dest]`,
    aliases: [],
    describe: `Builds the site into the desired destination.
    By default it will use a folder name 'site' in the root directory of the project.
    It won't build to a parent folder.
    The command will fail if _config.yml is invalid or not present.`,
    builder: builder,
    handler: handler,
};
