class Token {
    constructor(value) {
        this.value = value
    }
}

class BiGram extends Token {
    is_complete() {
        return this.value.length >= 2
    }
}

class English extends Token {
    constructor(value) {
        super(value)
        this.value = this.value.toLowerCase()
    }
}

function string_to_token(text, aliases) {
    const tokens = []

    const stop_words = new Set([
        "[图片]",
        "[表情]"
    ])

    for (const names of Object.values(aliases))
        for (const name in names)
            stop_words.add('@' + name)

    for (const stop_word of Array.from(stop_words).sort((a, b) => b.length - a.length)) // remove longest first (because some use names that are prefixes of others)
        text = text.replaceAll(stop_word, " ")

    const is_chinese = c => /\p{Script=Han}/u.test(c)
    const is_english = c => /[a-zA-Z]/u.test(c)

    let state = null // state is an incomplete

    for (const char of text + '\0') switch (true) {
        case state instanceof BiGram: {
            if (state.is_complete())
                tokens.push(state)

            switch (true) {
                case is_chinese(char):
                    state = new BiGram((state.value + char).slice(-2))
                    break

                case is_english(char): {
                    state = new English(char)
                    break
                }

                default:
                    state = null
            }

            break
        }

        case state instanceof English: {
            switch (true) {
                case is_chinese(char):
                    tokens.push(state)
                    state = new BiGram(char)
                    break

                case is_english(char): {
                    state = new English(state.value + char)
                    break
                }

                default:
                    tokens.push(state)
                    state = null
            }

            break
        }

        default: {
            switch (true) {
                case is_chinese(char):
                    state = new BiGram(char)
                    break
                case is_english(char):
                    state = new English(char)
                    break
                default:
                    state = null
            }
        }
    }

    return tokens
}

function parse_header(text) {
    const header_format = /^(\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}:\d{2}) (.*)(\((\d+)\)|<([^<>]+)>)$/

    const match_result = text.match(header_format)

    if (match_result === null)
        return null

    const [, time, name, , qq, email] = match_result

    return { time, name, id: qq || email }
}

function parse(text) {
    const aliases = Object.create(null) // { id: { name: count } }

    const messages = []

    for (const line of text.split(/\r?\n/)) {
        const header = parse_header(line)

        if (header != null) {
            const { time, name, id } = header
            messages.push({ time: Date.parse(time) / 1000, id, tokens: [] })
            aliases[id] = aliases[id] ?? Object.create(null)
            aliases[id][name] = (aliases[id][name] ?? 0) + 1
            continue
        }

        if (messages.length == 0) // comments before first message
            continue

        // the aliases are not complete yet, but I don't want to go two passes
        messages[messages.length - 1].tokens.push(...string_to_token(line, aliases))
    }

    return { aliases, messages }
}

// remove all messages from a specific id. Optionally remove its parent message (for bot commands)
function remove_id(messages, id_to_remove, remove_parent_message = false) {
    const to_remove = messages.map(() => false)

    for (let i = 0; i < messages.length; i++) {
        if (messages[i].id == id_to_remove) {
            to_remove[i] = true
            if (remove_parent_message) {
                let j = i - 1;
                while (j >= 0 && to_remove[j]) // find last message that is not removed (sometimes bot is slow)
                    j--
                to_remove[j] = true
            }
        }
    }

    return messages.filter((_, i) => !to_remove[i])
}

async function sha256(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder("utf-8").encode('🐕' + str + '🐶'))
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

const black_list = [
    "k9URW8fQMo2wan1I7CmyAxX9RBISFj3xoNtcbLvQk5M="
]

async function clean(messages, aliases, interactive_bot_ids = [], non_interactive_bot_ids = []) {
    // remove empty messages
    // messages = messages.filter(m => m.tokens.length > 0)
    // empty messages are useful for session detection

    // remove messages from blacklisted ids
    for (const id in aliases) if (black_list.includes(await sha256(id))) {
        messages = remove_id(messages, id, false)
        delete aliases[id]
    }

    // remove bot messages
    for (const id of interactive_bot_ids) {
        messages = remove_id(messages, id, true)
        delete aliases[id]
    }

    for (const id of non_interactive_bot_ids) {
        messages = remove_id(messages, id, false)
        delete aliases[id]
    }

    return { messages, aliases }
}

function detect_session(messages, gap_limit) {
    const sessions = []
    let last_time = 0

    for (const message of messages) {
        if (message.time - last_time > gap_limit)
            sessions.push([])
        sessions[sessions.length - 1].push(message)
        last_time = message.time
    }

    return sessions
}

const sum = list => list.reduce((a, b) => a + b, 0)

const mean = list => sum(list) / list.length

async function show_interation(messages, aliases) {
    const representitive_alias = get_representitive_alias(aliases)

    const links = Object.create(null)

    for (const session_gap of [30, 30 * 60])
        for (const session of detect_session(messages, session_gap)) {
            const message_count = Object.create(null)
            for (const { id } of session)
                message_count[id] = (message_count[id] ?? 0) + 1 / session.length
            for (const a in message_count) for (const b in message_count) if (a < b) {
                links[a] = links[a] ?? Object.create(null)
                links[a][b] = (links[a][b] ?? 0) + message_count[a] * message_count[b]
            }
        }

    const links_list = []
    for (const a in links) for (const b in links[a]) if (links[a][b] > 1)
        links_list.push({ source: a, target: b, value: links[a][b] })

    const maximum_link_value = Math.max(...links_list.map(({ value }) => value))
    for (const link of links_list)
        link.value /= maximum_link_value

    const graph = {
        nodes: Object.keys(aliases).map((id, i) => ({ id, group: i })),
        links: links_list
    }

    const svg = d3.select("svg")
    const width = +svg.attr("width")
    const height = +svg.attr("height")
    const color = d3.scaleOrdinal(d3.schemeSet1)

    const simulation = d3.forceSimulation()
        .force("link", d3.forceLink().id(d => d.id))
        .force("charge", d3.forceManyBody().strength(-25))
        .force("center", d3.forceCenter(width / 2, height / 2))
        .force("collide", d3.forceCollide().radius(20))

    const link = svg.append("g")
        .attr("class", "links")
        .selectAll("line")
        .data(graph.links)
        .enter().append("line")
        .attr("stroke-width", d => d.value * 5)

    const node = svg.append("g")
        .attr("class", "nodes")
        .selectAll("g")
        .data(graph.nodes)
        .enter().append("g")

    const circles = node.append("circle")
        .attr("r", 5)
        .attr("fill", d => color(d.group))

    const drag_handler = d3.drag()
        .on("start", d => {
            simulation.alphaTarget(0.3).restart()
        })
        .on("drag", (e, d) => {
            d.fx = e.x
            d.fy = e.y
        })
        .on("end", (e, d) => {
            simulation.alphaTarget(0)
            d.fx = null
            d.fy = null
        })

    drag_handler(node)

    node.append("text")
        .text(d => representitive_alias[d.id])
        .attr('x', 6)
        .attr('y', 3)

    node.append("title")
        .text(d => d.id)

    simulation.nodes(graph.nodes)
        .on("tick", () => {
            link
                .attr("x1", d => d.source.x)
                .attr("y1", d => d.source.y)
                .attr("x2", d => d.target.x)
                .attr("y2", d => d.target.y)

            node
                .attr("transform", d => "translate(" + d.x + "," + d.y + ")")
        })

    simulation.force("link")
        .links(graph.links)
        .strength(d => (Math.log(Math.exp(1) + d.value) - 1) / 10)

    // buggy

    // const zoom = d3.zoom()
    //     .on('zoom', e => svg.attr('transform', d3.event.transform))

    // svg.call(zoom)
}

const get_representitive_alias = aliases => Object.fromEntries(Object.entries(aliases).map(([id, name_counts]) => [id, Object.entries(name_counts).sort((a, b) => b[1] - a[1])[0][0]]))

const get_ids_by_message_count = aliases => Object.entries(aliases).map(([id, name_counts]) => [id, sum(Object.values(name_counts))]).sort((a, b) => b[1] - a[1]).map(([id, ]) => id)

function calc_tfidf(messages) {
    const tf = Object.create(null) // { id: { token: count } }
    const df = Object.create(null) // { token: Set(id) }

    for (const { id, tokens } of messages) {
        const words = new Set(tokens.map(token => token.value))
        tf[id] = tf[id] ?? Object.create(null)

        for (const word of words) {
            tf[id][word] = (tf[id][word] ?? 0) + 1
            df[word] = df[word] ?? new Set()
            df[word].add(id)
        }
    }

    const tfidf = Object.create(null) // { id: { token: tfidf } }
    for (const id in tf) {
        tfidf[id] = tfidf[id] ?? Object.create(null)
        const total_words = sum(Object.values(tf[id]))
        for (const word in tf[id]) if (df[word].size > 1) // at least said by two people (to filter some non-word words)
            tfidf[id][word] = tf[id][word] / total_words * Math.log(Object.keys(tf).length / (df[word].size + 1))
    }

    return tfidf
}

async function show_tfidf(messages, aliases) {
    const representitive_alias = get_representitive_alias(aliases)
    const tfidf = calc_tfidf(messages)

    let result = ''

    for (const id of get_ids_by_message_count(aliases)) if (tfidf[id])
        result += representitive_alias[id] + ': ' + Object.entries(tfidf[id]).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([word, ]) => word).join(', ') + '\n'

    document.getElementById('tfidf').innerText = result
}


async function main() {
    const file = document.getElementById("data").files[0]
    const text = await file.text()
    let { messages, aliases } = parse(text)
    ;({ messages, aliases } = await clean(
        messages, aliases,
        document.getElementById("bot")?.value.split(",") ?? [],
        document.getElementById("bot2")?.value.split(",") ?? []
    ))
    await show_interation(messages, aliases)
    await show_tfidf(messages, aliases)
}

async function test() {
    const text = Deno.readTextFileSync(Deno.args[0])

    let { messages, aliases } = parse(text)

    // console.log(messages.length, aliases)

    ;({ messages, aliases } = await clean(messages, aliases, Deno.args.slice(1)))

    // console.log(messages.length, aliases)

    // const hot_sessions = detect_session(messages, 30)
    // console.log(hot_sessions.length, mean(hot_sessions.map(s => s.length)))

    // const cold_sessions = detect_session(messages, 30 * 60)
    // console.log(cold_sessions.length, mean(cold_sessions.map(s => s.length)))

    console.log(calc_tfidf(messages))
}

if (typeof Deno != 'undefined')
    test()

if (typeof document != 'undefined')
    document.getElementById("data").addEventListener("change", main)
