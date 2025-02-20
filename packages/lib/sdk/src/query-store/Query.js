import { nanoid } from 'nanoid';
import { isDebug } from '../lib/debug.js';
import { Query as QueryBuilder, sql, sql as taggedSql } from '@uwdata/mosaic-sql';
import { EvidenceError } from '../lib/EvidenceError.js';
import { sharedPromise } from '../lib/sharedPromise.js';
import { resolveMaybePromise } from './utils.js';

/**
 * @typedef {import("./types.js").QueryResultRow} QueryResultRow
 */

/**
 * @template T
 * @typedef {import('./types.js').MaybePromise<T>} MaybePromise
 */

/**
 * @template {QueryResultRow} RowType
 * @typedef  {import('../lib/sharedPromise.js').SharedPromise<Query<RowType>>} ChainableSharedPromise
 */

/**
 * @template {QueryResultRow[]} RowType
 * @typedef {import("svelte/store").Readable<RowType>} Readable
 */

/**
 * @template {QueryResultRow} [RowType=QueryResultRow]
 * @typedef {RowType[] & Query<RowType>} QueryValue
 */

/**
 * @typedef {Object} QueryEvents<RowType>
 * @property {undefined} dataReady
 * @property {number} highScore
 * @property {Error} error
 */

/**
 * @typedef {import('./types.js').EventEmitter<QueryEvents>} QueryEventEmitter
 */

/**
 * @class
 * @template {QueryResultRow} [RowType=QueryResultRow]
 * @implements {Query<RowType>}
 * @implements {Readable<QueryValue<RowType>>}
 * @implements {QueryEventEmitter}
 */
export class Query {
	////////////////////////////
	/// < State Primatives > ///
	////////////////////////////
	#hasInitialData = false;

	/** @type {QueryValue<RowType>} */
	#value;

	get value() {
		return this.#value;
	}

	/// Data
	/** @type {RowType[]} */
	#data = [];
	get dataLoaded() {
		return ['resolved', 'rejected'].includes(this.#sharedDataPromise.state);
	}
	get dataLoading() {
		return this.#sharedDataPromise.state === 'loading';
	}
	/// Length
	/** @type {number} */
	#length = 0;
	get length() {
		return this.#length;
	}
	get lengthLoaded() {
		return ['resolved', 'rejected'].includes(this.#sharedLengthPromise.state);
	}
	get lengthLoading() {
		return this.#sharedLengthPromise.state === 'loading';
	}

	/// Columns
	/** @type {import('../types/duckdb-wellknown.js').DescribeResultRow[]} */
	#columns = [];
	/** @type {Record<keyof RowType, undefined> | undefined} */
	#mockRow = undefined;

	get columns() {
		return this.#columns;
	}
	get columnsLoaded() {
		return ['resolved', 'rejected'].includes(this.#sharedColumnsPromise.state);
	}
	get columnsLoading() {
		return this.#sharedColumnsPromise.state === 'loading';
	}

	/**
	 * True when data, length, and columns have all been fetched
	 */
	get ready() {
		return (
			this.#sharedLengthPromise.state === 'resolved' &&
			this.#sharedColumnsPromise.state === 'resolved' &&
			this.#sharedDataPromise.state === 'resolved'
		);
	}
	/**
	 * True when data, length, or columns are currently being fetched
	 */
	get loading() {
		return (
			this.#sharedLengthPromise.state === 'loading' ||
			this.#sharedColumnsPromise.state === 'loading' ||
			this.#sharedDataPromise.state === 'loading'
		);
	}

	/**
	 * Use the getter/setter for #error instead of this value directly
	 * @type {Error | undefined}
	 */
	#__error;

	get #error() {
		return this.#__error;
	}
	/**
	 * @param {Error | undefined} v
	 */
	set #error(v) {
		console.log(v);
		if (!v) return;
		this.#emit('error', v);
		this.#__error = v;
	}
	get error() {
		return this.#error;
	}

	/** @type {QueryBuilder} */
	#query;
	/** @type {string} */
	#originalText;
	/**
	 * The Query text as is was provided
	 */
	get originalText() {
		return this.#originalText;
	}
	/**
	 * The Query text as it is being executed
	 */
	get text() {
		return this.#query.toString();
	}

	//////////////////////////////
	/// </ State Primatives /> ///
	//////////////////////////////

	////////////////////
	/// < Fetching > ///
	////////////////////

	/** @type {ChainableSharedPromise<RowType>} */
	#sharedDataPromise = sharedPromise(() =>
		this.publish(`data promise (${this.#sharedDataPromise.state})`)
	);
	/** @returns {MaybePromise<Query<RowType>>} */
	#fetchData = () => {
		if (this.#sharedDataPromise.state !== 'init') {
			return this.#sharedDataPromise.promise;
		}
		if (this.#error) {
			this.#debug('Refusing to execute data query, store has an error state');
			return this.#sharedDataPromise.promise;
		}
		if (this.#sharedDataPromise.state !== 'init' || this.opts.noResolve)
			return this.#sharedDataPromise.promise;
		this.#sharedDataPromise.start();

		this.#debug('Beginning Data Fetch');

		const queryWithComment =
			`---- Data ${this.#id} ${this.#hash}
        ${this.#query.toString()}
        `.trim() + '\n';

		// gotta love jsdoc sometimes
		const typedRunner = /** @type {import('./types.js').Runner<RowType>} */ (this.#executeQuery);

		const resolved = resolveMaybePromise(
			(result, isPromise) => {
				this.#data.push(...result);
				this.#sharedDataPromise.resolve(this);
				this.#emit('dataReady', undefined);
				if (isPromise) {
					return this.#sharedDataPromise;
				} else {
					return this;
				}
			},
			typedRunner(queryWithComment, `${this.#id}_columns`),
			(e, isPromise) => {
				this.#error = e;
				this.#sharedDataPromise.reject(e);
				if (isPromise) return this.#sharedDataPromise;
				else throw e;
			}
		);
		return /** @type {MaybePromise<Query<RowType>>} */ (resolved);
	};
	fetch = this.#fetchData;

	/** @type {ChainableSharedPromise<RowType>} */
	#sharedLengthPromise = sharedPromise(() =>
		this.publish(`length promise (${this.#sharedLengthPromise.state})`)
	);
	/** @returns {MaybePromise<Query<RowType>>} */
	#fetchLength = () => {
		// If data has already been fetched, or provided
		// Don't query for the length again
		if (
			this.#data &&
			this.#sharedDataPromise.state === 'resolved' &&
			this.#sharedLengthPromise.state === 'init'
		) {
			this.#length = this.#data.length;
			// Done
			this.#sharedLengthPromise.resolve(this);
			return this.#sharedLengthPromise.promise;
		}
		if (this.#error) {
			this.#debug('Refusing to execute length query, store has an error state');
			this.#sharedLengthPromise.reject(this.#error); // Is this the right call?
			return this.#sharedLengthPromise.value ?? this.#sharedLengthPromise.promise;
		}
		if (this.#sharedLengthPromise.state !== 'init' || this.opts.noResolve)
			return this.#sharedLengthPromise.promise;

		this.#sharedLengthPromise.start();

		const lengthQuery =
			`
        ---- Length ${this.#id} (${this.#hash})
        SELECT COUNT(*) as rowCount FROM (${this.text})
        `.trim() + '\n';

		// gotta love jsdoc sometimes
		const typedRunner =
			/** @type {import('./types.js').Runner<{rowCount: number}>} */
			(this.#executeQuery);

		const resolved = resolveMaybePromise(
			/** @returns {MaybePromise<Query<RowType>>} */
			(lengthResult, isPromise) => {
				this.#length = lengthResult[0].rowCount;
				this.#sharedLengthPromise.resolve(this);
				if (isPromise) {
					return this.#sharedLengthPromise.promise;
				} else {
					return this;
				}
			},
			typedRunner(lengthQuery, `${this.#id}_columns`),
			/** @returns {MaybePromise<Query<RowType>>} */
			(e, isPromise) => {
				this.#error = e;
				this.#sharedLengthPromise.reject(e);
				if (isPromise) return this.#sharedLengthPromise.promise;
				else throw e;
			}
		);
		return /** @type {MaybePromise<Query<RowType>>} */ (resolved);
	};

	/** @type {ChainableSharedPromise<RowType>} */
	#sharedColumnsPromise = sharedPromise(() =>
		this.publish(`columns promise (${this.#sharedColumnsPromise.state})`)
	);
	/** @returns {MaybePromise<Query<RowType>>} */
	#fetchColumns = () => {
		if (this.#error) {
			this.#debug('Refusing to execute columns query, store has an error state');
			// Return the value or the promise if not resolved
			return this.#sharedColumnsPromise.value ?? this.#sharedColumnsPromise.promise;
		}

		// Store is in some started state
		if (this.#sharedColumnsPromise.state !== 'init' || this.opts.noResolve)
			return this.#sharedColumnsPromise.promise;
		// Indicate that work has started on this promise
		this.#sharedColumnsPromise.start();

		const metaQuery =
			`
        ---- Columns ${this.#id} (${this.#hash})
        DESCRIBE ${this.#query.toString()}
        `.trim() + '\n';

		// gotta love jsdoc sometimes
		const typedRunner =
			/** @type {import('./types.js').Runner<import('../types/duckdb-wellknown.js').DescribeResultRow>} */
			(this.#executeQuery);

		const resolved = resolveMaybePromise(
			(description, isPromise) => {
				// Update inner value
				this.#columns = description;
				// Resolve store
				this.#sharedColumnsPromise.resolve(this);

				this.#mockRow = /** @type {Record<keyof RowType, undefined>} */ (
					Object.fromEntries(description.map((d) => [d.column_name, undefined]))
				);

				if (isPromise) {
					return this.#sharedColumnsPromise.promise;
				} else {
					return this;
				}
			},
			typedRunner(metaQuery, `${this.#id}_columns`),
			/** @returns {MaybePromise<Query<RowType>>} */
			(e, isPromise) => {
				this.#error = e;
				this.#sharedColumnsPromise.reject(e);

				if (isPromise)
					return this.#sharedColumnsPromise.promise; // rejected promise
				else throw e;
			}
		);
		return /** @type {MaybePromise<Query<RowType>>} */ (resolved);
	};
	//////////////////////
	/// </ Fetching /> ///
	//////////////////////

	//////////////////////////
	/// < Type Narrowing > ///
	//////////////////////////
	/**
	 * @ignore
	 * @private
	 */
	get isQuery() {
		return true;
	}

	/**
	 * @template {QueryResultRow} RowType
	 * @param {unknown} q
	 * @returns {q is Query<RowType>}
	 */
	static isQuery = (q) => {
		// TODO: Should we type-narrow on row type as well
		// Type narrow
		if (typeof q !== 'object' || !q) return false;

		const hasDuckType = 'isQuery' in q && q['isQuery'] === true;

		return hasDuckType;
	};
	////////////////////////////
	/// </ Type Narrowing /> ///
	////////////////////////////

	/** @param {unknown} v */
	static [Symbol.hasInstance](v) {
		return Query.isQuery(v);
	}

	/////////////////
	/// < Proxy > ///
	/////////////////
	/** @type {string[]} */
	static get ProxyFetchTriggers() {
		return ['at'];
	}
	/** @returns {QueryValue<RowType>} */
	#buildProxy = () => {
		/** @type {QueryValue<RowType>} */
		const proxy = /** @type {QueryValue<RowType>} */ (
			new Proxy(this.#data, {
				getPrototypeOf: () => {
					return Object.getPrototypeOf(this.#data);
				},
				has: (self, prop) => {
					return prop in this.#data || prop in this;
				},
				get: (_self, rawProp) => {
					/** @type {string | symbol | number} */
					let prop = rawProp;

					if (typeof prop === 'string' && /^[\d.]+$/.exec(prop)) prop = parseInt(prop);

					if (typeof prop === 'number' || Query.ProxyFetchTriggers.includes(prop.toString())) {
						if (this.#sharedDataPromise.state === 'init') {
							this.#debug(`Implicit query fetch triggered by ${prop.toString()}`);
							this.#fetchData(); // catches itself
						}
					}

					if (prop === 'length') {
						this.#fetchLength();
					}
					if (prop === 'constructor') return this.#data.constructor;
					if (prop === 'toString') return this.#data.toString.bind(this.#data);

					// Default field resolution
					const target =
						prop in this
							? this // Prop exists on Query
							: this.#data && prop in this.#data
								? this.#data // Prop exists on Array
								: null; // Prop exists on neither
					if (target === null)
						if (typeof prop !== 'number') return undefined;
						else {
							if (prop > this.#length) return undefined;
							return this.#mockRow ?? {};
						}

					const field = target[/** @type {keyof typeof target} */ (prop)];

					if (typeof field === 'function') return field.bind(target);
					else return field;
				}
			})
		);

		return proxy;
	};
	///////////////////
	/// </ Proxy /> ///
	///////////////////

	/////////////////////
	/// < Factories > ///
	/////////////////////

	static #cache = new Map();

	/**
	 * @template {QueryResultRow} [RowType=QueryResultRow]
	 * @type {import("./types.js").CreateQuery<RowType>}
	 * @returns {QueryValue<RowType>}
	 */
	static create = (query, executeQuery, optsOrId, maybeOpts) => {
		/** @type {import('./types.js').QueryOpts<RowType>} */
		let opts;
		if (typeof optsOrId === 'string') {
			opts = {
				...maybeOpts,
				id: optsOrId
			};
		} else if (optsOrId) {
			opts = optsOrId;
		} else {
			throw new Error();
		}
		const queryHash = hashQuery(query);
		if (Query.#cache.has(queryHash) && !opts.disableCache) {
			if (isDebug()) console.log(`Using cached query ${opts.id ?? ''}`);
			return Query.#cache.get(queryHash);
		}

		Query.#constructing = true;
		const output = new Query(query, executeQuery, opts).value;
		Query.#cache.set(queryHash, output);
		return output.value;
	};

	///////////////////////
	/// </ Factories /> ///
	///////////////////////

	#debug = isDebug()
		? (/** @type {Parameters<typeof console.debug>} */ ...args) =>
				console.debug(`${(performance.now() / 1000).toFixed(3)} | ${this.id}`, ...args)
		: () => {};

	static #constructing = false;

	/** @type {string} */
	#id;
	/** @type {string} */
	#hash;
	/** @type {string} */
	get id() {
		return this.#id;
	}
	/** @type {string} */
	get hash() {
		return this.#hash;
	}

	/** @type {import('./types.js').Runner} */
	#executeQuery;

	/** @type {import('./types.js').QueryOpts} */
	opts;

	// TODO: Score (this should be done in another file)
	// TODO: When dealing with builder functions, add a `select` or similar
	/**
	 * @param {QueryBuilder | string} query
	 * @param {import('./types.js').Runner} executeQuery
	 * @param {import("./types.js").QueryOpts<RowType>} opts
	 * @deprecated Use {@link Query.create} instead
	 */
	constructor(query, executeQuery, opts = {}) {
		const {
			id,
			initialData = undefined,
			knownColumns = undefined,
			initialError = undefined
		} = opts;

		this.opts = opts;
		this.#executeQuery = executeQuery;

		if (typeof query !== 'string' && !(query instanceof QueryBuilder)) {
			throw new EvidenceError('Refusing to create Query, no query text provided', [
				JSON.stringify(opts)
			]);
		}

		if (!Query.#constructing) {
			console.warn(
				'Directly using new Query() is not a recommended use-case. Please use Query.create()'
			);
		}
		Query.#constructing = false; // make sure we reset it

		this.#originalText = query.toString();
		if (typeof query !== 'string') this.#query = query;
		else {
			const q = new QueryBuilder()
				.from({
					/* 
						Use of nanoid prevent ambiguity when dealing with nested Queries; 
						in theory this could be the querystring has but that's kinda gross 
					*/
					[`inputQuery-${nanoid(2)}`]: taggedSql`(${query})`
				})
				.select('*');
			this.#query = q;
		}

		this.#hash = hashQuery(this.#originalText);
		this.#id = id ?? this.#hash;
		this.#value = this.#buildProxy();

		if (initialError) {
			this.#error = initialError;
			return;
		}

		if (initialData) {
			this.#debug('Created with initial data');
			this.#hasInitialData = true;
			this.#data.push(...initialData);
			this.#sharedDataPromise.resolve(this);
		}
		if (knownColumns) {
			if (!Array.isArray(knownColumns))
				throw new Error(`Expected knownColumns to be an array`, { cause: knownColumns });
			this.#columns = knownColumns;
		} else {
			resolveMaybePromise(
				() => {
					/* We don't need to do anything with the result */
				},
				this.#fetchColumns(),
				(e, isPromise) => {
					/* Async errors are handled elsewhere */ if (!isPromise) throw e;
				}
			);
		}
		resolveMaybePromise(
			() => {
				/* We don't need to do anything with the result */
			},
			this.#fetchLength(),
			(e, isPromise) => {
				/* Async errors are handled elsewhere */ if (!isPromise) throw e;
			}
		);
	}

	////////////////////////////////////
	/// < Implement Store Contract > ///
	////////////////////////////////////
	/** @type {Set<import('./types.js').Subscriber<QueryValue<RowType>>>} */
	#subscribers = new Set();

	/**
	 * @param {import('./types.js').Subscriber<QueryValue<RowType>>} fn
	 * @returns {() => void} Unsubscribe function
	 */
	subscribe = (fn) => {
		this.#subscribers.add(fn);
		fn(this.#value);
		return () => this.#subscribers.delete(fn);
	};

	#publishIdx = 0;
	/**
	 * @protected
	 */
	publish = (/** @type {string} */ source) => {
		if (this.#publishIdx++ > 100000) throw new Error('Query published too many times.');
		this.#debug(`Publishing triggered by ${source}`);
		this.#subscribers.forEach((fn) => fn(this.#value));
	};
	//////////////////////////////////////
	/// </ Implement Store Contract /> ///
	//////////////////////////////////////

	///////////////////////////////////////
	/// < EventEmitter Implementation > ///
	///////////////////////////////////////
	/** @type {import('./types.js').EventMap<QueryEvents>} */
	#handlerMap = {
		dataReady: new Set(),
		error: new Set(),
		highScore: new Set()
	};

	/**
	 * @template {keyof QueryEvents} Event
	 * @param {Event} event
	 * @param {QueryEvents[Event]} value
	 */
	#emit = (event, value) => {
		this.#handlerMap[event].forEach((fn) => {
			fn(value);
		});
	};

	/**
	 * @template {keyof QueryEvents} Event
	 * @param {Event} event
	 * @param {(v: QueryEvents[Event]) => void} handler
	 */
	on = (event, handler) => {
		this.#handlerMap[event].add(handler);
	};
	/**
	 * @template {keyof QueryEvents} Event
	 * @param {Event} event
	 * @param {(v: QueryEvents[Event]) => void} handler
	 */
	off = (event, handler) => {
		this.#handlerMap[event].delete(handler);
	};
	addEventListener = this.on;
	removeEventListener = this.off;

	/////////////////////////////////////////
	/// </ EventEmitter Implementation /> ///
	/////////////////////////////////////////

	//////////////////////////////////
	/// < QueryBuilder Interface > ///
	//////////////////////////////////
	/** @param {string} filterStatement */
	where = (filterStatement) =>
		Query.create(this.#query.clone().where(sql`${filterStatement}`), this.#executeQuery, {
			knownColumns: this.#columns
		});
	/** @param {number} limit */
	limit = (limit) =>
		Query.create(this.#query.clone().limit(limit), this.#executeQuery, {
			knownColumns: this.#columns
		});
	/** @param {number} offset */
	offset = (offset) =>
		Query.create(this.#query.clone().offset(offset), this.#executeQuery, {
			knownColumns: this.#columns
		});
	/**
	 * @param {number} offset
	 * @param {number} limit
	 */
	paginate = (offset, limit) =>
		Query.create(this.#query.clone().offset(offset).limit(limit), this.#executeQuery, {
			knownColumns: this.#columns
		});

	////////////////////////////////////
	/// </ QueryBuilder Interface /> ///
	////////////////////////////////////
}

/**
 * @param  {...any} args
 * @returns {string}
 */
export const hashQuery = (...args) => {
	/**
	 * @param {string} str
	 * @returns {string}
	 */
	const simpleHash = (str) => {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash &= hash; // Convert to 32bit integer
		}
		return new Uint32Array([hash])[0].toString(36);
	};
	return simpleHash(JSON.stringify(args));
};
