
function makeEnum_V(l)
{
    o = {};
    l.forEach(element => {
        o[element[0]] = element[1];
    });
    return Object.freeze(o);
}

function makeEnum(l)
{
    return makeEnum_V(l.map((e)=>[e, e]))
}

const OPERATOR_ARGS = makeEnum([
    "ARGS_0",
    "ARGS_1",
    "ARGS_2"
]);

const OPERATOR_DIRECTION = makeEnum([
    "L_TO_R",
    "R_TO_L",
    "NONE"
]);

const SIGNEDNESS = makeEnum([
    "SIGNED",
    "UNSIGNED",
    "NONE"
])

class ValueWrapper_LITERAL {
    constructor(v, signed) {
        this.v = v;
        this.signed = signed;
    }

    getValue(defines)
    {
        return {
            value : this.v,
            signed : this.signed
        }
    }
}

class ValueWrapper_VARIABLE {
    constructor(v, signed) {
        this.vName = v;
        this.signed = signed;
    }

    getValue(defines)
    {
        return {
            value : defines.get(this.vName),
            signed : this.signed
        }
    }
}

class Operator {
    constructor(symbol, token, precedence, direction, arg_num, operator, resultingSignedness) {
        this.symbol = symbol;
        this.token = token;
        this.precedence = precedence;
        this.direction = direction;
        this.operator = operator;
        this.arg_num = arg_num;
        this.signed = resultingSignedness;
    }
}

function to_unsigned(val, bitCount)
{
    // if nan or infinite just return the bad number, 
    // casting hides the fact that its nan or infinity
    if (!Number.isFinite(val))
    {
        return val;
    }

    //! BUG: Doesn't work with bitCount > 32

    // we're gonna use masking to retrieve the bits of our number; 8 => 0xff, 16 => 0xffff
    // but we don't want to use the 2**bitCount-1, too expensive.
    // we can't use (1<<bitCount)-1 because 1<<32 == 1, it loops around.
    // we'll take a (u32)(-1) and shift out the bits.
    // 32 shifts out 0, 8 shifts out 24.
    // `>>>` is the right shift for unsigned ints, it casts to a u32
    const bitMask = (-1) >>> (32 - bitCount);

    // bit masking doesn't work for u32 numbers, cuz masking returns a 32-bit signed int.
    // add a u32 right shift operator to cast
    return (val & bitMask) >>> 0;
}

function to_signed(val, bitCount)
{
    // if nan or infinite just return the bad number, 
    // casting hides the fact that its nan or infinity
    if (!Number.isFinite(val))
    {
        return val;
    }

    //! BUG: Doesn't work with bitCount > 32

    // we want half the max of 2**bitCount; 256 => 128
    // essentially what the value would be if the top bit was set, and all others were 0.
    // we can get that easy with 1<<(bitCount-1); 1<<(8-1) == 128
    // because shift operators return a s32, the result will be negative if we use 32 bits (not what we want),
    // add a u32 shift operator to cast to u32
    const halfMax = (1 << (bitCount - 1)) >>> 0;

    // add half the max so values with the top bit set will overflow, then mod around to being lower when cast to unsigned
    // then sub the half so the overflowed values become negative, and the non-overflowed values don't change
    return to_unsigned(val + halfMax, bitCount) - halfMax;
}

const to_u32 = (x) => to_unsigned(x, 32); 
const to_s32 = (x) => to_signed(x, 32);
const to_u16 = (x) => to_unsigned(x, 16);
const to_s16 = (x) => to_signed(x, 16);
const to_u8 = (x) => to_unsigned(x, 8);
const to_s8 = (x) => to_signed(x, 8);

function MakeOpWrapper(operator_object) {
    return class {
        constructor(...args)
        {
            this.args = args;
            this.op_object = operator_object;
        }

        getValue(defines)
        {
            if (this.op_object.arg_num == OPERATOR_ARGS.ARGS_0)
            {
                let [v] = this.args;

                // this will be an object that contains the value and signed information
                let v_value = v.getValue(defines);
                
                // just return the value and signed information
                return v_value;
            }
            else if (this.op_object.arg_num == OPERATOR_ARGS.ARGS_1)
            {
                let [v] = this.args;
                // this will be an object that contains the value and signed information
                let v_res = v.getValue(defines);

                let ret_value = this.op_object.operator(v_res.value);

                // if the operator has an express signedness, return that sign, otherwise return the values sign
                const result_signedness = this.op_object.signed != SIGNEDNESS.NONE ? this.op_object.signed : v_res.signed;
                return {
                    value : ret_value,
                    signed : result_signedness
                };
            }
            else if (this.op_object.arg_num == OPERATOR_ARGS.ARGS_2)
            {
                let [ls, rs] = this.args;
                
                let ls_value = ls.getValue(defines);
                let rs_value = rs.getValue(defines);

                let signedness = SIGNEDNESS.SIGNED;

                if (this.op_object.token == OPERATOR_TOKEN.LOGICAL_COMMA)
                {
                    // pass, the value on the left side of comma has nothing to do with the right side
                }
                else if (ls_value.signed == SIGNEDNESS.UNSIGNED || rs_value.signed == SIGNEDNESS.UNSIGNED) {
                    // if either operand is unsigned, treat both as unsigned
                    signedness = SIGNEDNESS.UNSIGNED;
                    rs_value.value = to_u32(rs_value.value);
                    ls_value.value = to_u32(ls_value.value);
                }

                let ret_value;
                // special case for javascript's implementation of bit shifting always using s32
                if (this.op_object.token == OPERATOR_TOKEN.BITWISE_RS && signedness == SIGNEDNESS.UNSIGNED)
                {
                    ret_value = ls_value.value >>> rs_value.value;
                }
                else
                {
                    ret_value = this.op_object.operator(ls_value.value, rs_value.value);
                }

                const result_signedness = this.op_object.signed != SIGNEDNESS.NONE ? this.op_object.signed : signedness;

                // sanity check to make sure we're in the right space
                if (result_signedness == SIGNEDNESS.UNSIGNED)
                {
                    ret_value = to_u32(ret_value);
                }
                else
                {
                    ret_value = to_s32(ret_value);
                }

                return {
                    value : ret_value,
                    signed : result_signedness
                }
            }
        }
    };
}

// Taken from https://en.cppreference.com/w/c/language/operator_precedence
ALL_OPERATORS = [
    new Operator('(', "BRACKET_OPEN", 0, OPERATOR_DIRECTION.NONE, OPERATOR_ARGS.ARGS_0, () => undefined, SIGNEDNESS.NONE),
    new Operator(')', "BRACKET_CLOSE", 0, OPERATOR_DIRECTION.NONE, OPERATOR_ARGS.ARGS_0, () => undefined, SIGNEDNESS.NONE),
    
    new Operator("LZCOUNT", "LZCOUNT", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => {
        let u = to_u32(v);
        for (i = 0; i < 32; i++)
        {
            if ((u >> i) == 0) return (32 - i);
        }

        return 0;
    }, SIGNEDNESS.SIGNED),

    new Operator("cntlzw", "LZCOUNT", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => {
        let u = to_u32(v);
        for (i = 0; i < 32; i++)
        {
            if ((u >> i) == 0) return (32 - i);
        }

        return 0;
    }, SIGNEDNESS.SIGNED),

    new Operator('~', "BITWISE_NOT", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => ~v, SIGNEDNESS.NONE),
    new Operator('!', "LOGICAL_NOT", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => (!v) ? 1 : 0, SIGNEDNESS.SIGNED),
    new Operator('-', "MATH_NEGATE", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => -v, SIGNEDNESS.NONE),
    new Operator('+', "MATH_UNARY", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => v, SIGNEDNESS.NONE),
    
    new Operator('(u32)', "CAST_U32", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_u32(v), SIGNEDNESS.UNSIGNED),
    new Operator('(unsigned int)', "CAST_U32", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_u32(v), SIGNEDNESS.UNSIGNED),
    new Operator('(uint)', "CAST_U32", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_u32(v), SIGNEDNESS.UNSIGNED),
    new Operator('(unsigned long)', "CAST_U32", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_u32(v), SIGNEDNESS.UNSIGNED),
    new Operator('(ulong)', "CAST_U32", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_u32(v), SIGNEDNESS.UNSIGNED),
    new Operator('(uint32_t)', "CAST_U32", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_u32(v), SIGNEDNESS.UNSIGNED),

    new Operator('(s32)', "CAST_S32", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_s32(v), SIGNEDNESS.SIGNED),
    new Operator('(int)', "CAST_S32", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_s32(v), SIGNEDNESS.SIGNED),
    new Operator('(long)', "CAST_S32", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_s32(v), SIGNEDNESS.SIGNED),
    new Operator('(int32_t)', "CAST_S32", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_s32(v), SIGNEDNESS.SIGNED),

    new Operator('(u16)', "CAST_U16", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_u16(v), SIGNEDNESS.UNSIGNED),
    new Operator('(ushort)', "CAST_U16", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_u16(v), SIGNEDNESS.UNSIGNED),
    new Operator('(unsigned short)', "CAST_U16", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_u16(v), SIGNEDNESS.UNSIGNED),
    new Operator('(uint16_t)', "CAST_U16", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_u16(v), SIGNEDNESS.UNSIGNED),

    new Operator('(s16)', "CAST_S16", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_s16(v), SIGNEDNESS.SIGNED),
    new Operator('(short)', "CAST_S16", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_s16(v), SIGNEDNESS.SIGNED),
    new Operator('(int16_t)', "CAST_S16", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_s16(v), SIGNEDNESS.SIGNED),
    
    new Operator('(u8)', "CAST_U8", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_u8(v), SIGNEDNESS.UNSIGNED),
    new Operator('(unsigned char)', "CAST_U8", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_u8(v), SIGNEDNESS.UNSIGNED),
    new Operator('(uchar)', "CAST_U8", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_u8(v), SIGNEDNESS.UNSIGNED),
    new Operator('(byte)', "CAST_U8", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_u8(v), SIGNEDNESS.UNSIGNED),
    new Operator('(uint8_t)', "CAST_U8", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_u8(v), SIGNEDNESS.UNSIGNED),

    new Operator('(s8)', "CAST_S8", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_s8(v), SIGNEDNESS.SIGNED),
    new Operator('(char)', "CAST_S8", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_s8(v), SIGNEDNESS.SIGNED),
    new Operator('(sbyte)', "CAST_S8", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_s8(v), SIGNEDNESS.SIGNED),
    new Operator('(int8_t)', "CAST_S8", 2, OPERATOR_DIRECTION.R_TO_L, OPERATOR_ARGS.ARGS_1, (v) => to_s8(v), SIGNEDNESS.SIGNED),

    new Operator('*', "MATH_MUL", 3, OPERATOR_DIRECTION.L_TO_R, OPERATOR_ARGS.ARGS_2, (ls, rs) => ls * rs, SIGNEDNESS.NONE),
    new Operator('/', "MATH_DIV", 3, OPERATOR_DIRECTION.L_TO_R, OPERATOR_ARGS.ARGS_2, (ls, rs) => Math.trunc(ls / rs), SIGNEDNESS.NONE),
    new Operator('%', "MATH_MOD", 3, OPERATOR_DIRECTION.L_TO_R, OPERATOR_ARGS.ARGS_2, (ls, rs) => ls % rs, SIGNEDNESS.NONE),

    new Operator('+', "MATH_ADD", 4, OPERATOR_DIRECTION.L_TO_R, OPERATOR_ARGS.ARGS_2, (ls, rs) => ls + rs, SIGNEDNESS.NONE),
    new Operator('-', "MATH_SUB", 4, OPERATOR_DIRECTION.L_TO_R, OPERATOR_ARGS.ARGS_2, (ls, rs) => ls - rs, SIGNEDNESS.NONE),
    
    new Operator('<<', "BITWISE_LS", 5, OPERATOR_DIRECTION.L_TO_R, OPERATOR_ARGS.ARGS_2, (ls, rs) => ls << rs, SIGNEDNESS.NONE),
    new Operator('>>', "BITWISE_RS", 5, OPERATOR_DIRECTION.L_TO_R, OPERATOR_ARGS.ARGS_2, (ls, rs) => ls >> rs, SIGNEDNESS.NONE),
    
    new Operator('<', "LOGICAL_LT", 6, OPERATOR_DIRECTION.L_TO_R, OPERATOR_ARGS.ARGS_2, (ls, rs) => ls < rs ? 1 : 0, SIGNEDNESS.SIGNED),
    new Operator('>', "LOGICAL_GT", 6, OPERATOR_DIRECTION.L_TO_R, OPERATOR_ARGS.ARGS_2, (ls, rs) => ls > rs ? 1 : 0, SIGNEDNESS.SIGNED),
    new Operator('<=', "LOGICAL_LTE", 6, OPERATOR_DIRECTION.L_TO_R, OPERATOR_ARGS.ARGS_2, (ls, rs) => ls <= rs ? 1 : 0, SIGNEDNESS.SIGNED),
    new Operator('>=', "LOGICAL_GTE", 6, OPERATOR_DIRECTION.L_TO_R, OPERATOR_ARGS.ARGS_2, (ls, rs) => ls >= rs ? 1 : 0, SIGNEDNESS.SIGNED),

    new Operator('==', "LOGICAL_EQ", 7, OPERATOR_DIRECTION.L_TO_R, OPERATOR_ARGS.ARGS_2, (ls, rs) => ls == rs ? 1 : 0, SIGNEDNESS.SIGNED),
    new Operator('!=', "LOGICAL_NEQ", 7, OPERATOR_DIRECTION.L_TO_R, OPERATOR_ARGS.ARGS_2, (ls, rs) => ls != rs ? 1 : 0, SIGNEDNESS.SIGNED),

    new Operator('&', "BITWISE_AND", 8, OPERATOR_DIRECTION.L_TO_R, OPERATOR_ARGS.ARGS_2, (ls, rs) => ls & rs, SIGNEDNESS.NONE),
    
    new Operator('^', "BITWISE_XOR", 9, OPERATOR_DIRECTION.L_TO_R, OPERATOR_ARGS.ARGS_2, (ls, rs) => ls ^ rs, SIGNEDNESS.NONE),

    new Operator('|', "BITWISE_OR", 10, OPERATOR_DIRECTION.L_TO_R, OPERATOR_ARGS.ARGS_2, (ls, rs) => ls | rs, SIGNEDNESS.NONE),

    new Operator('&&', "LOGICAL_AND", 11, OPERATOR_DIRECTION.L_TO_R, OPERATOR_ARGS.ARGS_2, (ls, rs) => ls && rs ? 1 : 0, SIGNEDNESS.SIGNED),
    
    new Operator('||', "LOGICAL_OR", 12, OPERATOR_DIRECTION.L_TO_R, OPERATOR_ARGS.ARGS_2, (ls, rs) => ls || rs ? 1 : 0, SIGNEDNESS.SIGNED),
    
    new Operator(',', "LOGICAL_COMMA", 15, OPERATOR_DIRECTION.L_TO_R, OPERATOR_ARGS.ARGS_2, (ls, rs) => rs, SIGNEDNESS.NONE),
]

const OPERATOR_TOKEN = makeEnum(ALL_OPERATORS.map((e)=>e.token));

const OPERATOR_SYMBOL_TO_TOKEN = makeEnum_V(ALL_OPERATORS.map((e) => [e.symbol, e.token]));

const OPERATOR_TOKEN_TO_OPERATOR = makeEnum_V(ALL_OPERATORS.map((e)=>[e.token, e]));

const MAX_OPERATOR_SYMBOL_LENGTH = Math.max(...ALL_OPERATORS.map((e)=>e.symbol.length))

const TOKEN_TYPE = makeEnum([
    "VARIABLE_NAME",
    "NUMBER_LITERAL",
    "OPERATOR",
    "BRACKET",
    "ERROR_NO_TOKEN",
    "ERROR"
]);

const OPERATOR_TOKEN_TO_VALUEWRAPPER = makeEnum_V(ALL_OPERATORS.map((e)=>[e.token, MakeOpWrapper(e)]));


const formatNumber = (val) =>{
    if (Number.isFinite(val) && document.getElementById("HexCheck").checked)
    {
        let newVal = Math.abs(val).toString(16).toUpperCase();
        return (val < 0 ? "-0x" : "0x") + newVal;
    }
    else
    {
        return val.toString();
    }
}

function get_next_symbol_start(s_string, pos_int) {
    while (pos_int < s_string.length && s_string[pos_int] === ' ')
    {
        pos_int++;
    }
    return pos_int;
};

// regex to match a hex number, or a decimal number.
// Only at the beginning of the string, and has to be followed by 
// the end of the string, or an operator.
// also optional u or U at the end of a string, just allows matches with 
// unsigned shifts that come out of ghidra.
const num_regex = /^((((0(x|X)[0-9A-Fa-f]+))|([0-9]+))([u|U]?))(?:[^\w\d]|$)/;
function read_number(s_string, pos_int)
{
    const res = s_string.substring(pos_int).match(num_regex);
    if (res == null)
    {
        return {
            type: TOKEN_TYPE.ERROR_NO_TOKEN,
            value: `unable to read number_literal from string at ${pos_int}`
        }
    }

    // parse from group 1 (which won't capture the end character if its followed by an operator)
    const matchingString = res[1]
    const outNum = Number.parseInt(matchingString);
    
    if (outNum === NaN)
    {
        return {
            type: TOKEN_TYPE.ERROR,
            value: `can't parse value to int: ${matchingString}`
        }
    }

    const isUnsignedNum = (matchingString.includes("U")) || (matchingString.includes("u"));

    return {
        type: TOKEN_TYPE.NUMBER_LITERAL,
        value: {
            symbol : outNum,
            signed : isUnsignedNum ? SIGNEDNESS.UNSIGNED : SIGNEDNESS.SIGNED,
            new_offset : pos_int + matchingString.length
        }
    }
}

const var_regex = /^[a-zA-Z_][a-zA-Z0-9_]*/;
function read_variable(s_string, pos_int)
{
    let res = s_string.substring(pos_int).match(var_regex);
    if (res === null)
    {
        return {
            type: TOKEN_TYPE.ERROR_NO_TOKEN,
            value: `unable to read variable name from string at ${pos_int}`
        }
    }

    return {
        type: TOKEN_TYPE.VARIABLE_NAME,
        value: {
            symbol : res[0],
            signed : SIGNEDNESS.SIGNED,
            new_offset : pos_int + res[0].length
        }
    }
}

function read_operator(s_string, pos_int)
{
    // max number of characters in an operator
    const max_length = MAX_OPERATOR_SYMBOL_LENGTH;

    for (let i = max_length; i > 0; i--)
    {
        if (pos_int + i > s_string.length) continue;
        // read x many characters
        let new_symbol = s_string.substring(pos_int, pos_int + i);
        // see if its an operator
        if (OPERATOR_SYMBOL_TO_TOKEN.hasOwnProperty(new_symbol))
        {
            let new_token = OPERATOR_SYMBOL_TO_TOKEN[new_symbol]
            let ret_type = TOKEN_TYPE.OPERATOR;

            if (new_token == OPERATOR_TOKEN.BRACKET_OPEN || new_token == OPERATOR_TOKEN.BRACKET_CLOSE)
            {
                ret_type = TOKEN_TYPE.BRACKET;
            }
            
            return {
                type : ret_type,
                value : {
                    symbol : OPERATOR_TOKEN_TO_OPERATOR[new_token],
                    signed :  SIGNEDNESS.NONE,
                    new_offset : pos_int + new_symbol.length
                }
            };
        }
        
    }
    
    return {
        type:TOKEN_TYPE.ERROR_NO_TOKEN,
        value: `unable to read operator from string at ${pos_int}`
    }
};

function read_token(s_string, pos_int)
{
    pos_int = get_next_symbol_start(s_string, pos_int);
    if (pos_int >= s_string.length)
    {
        return {
            type:TOKEN_TYPE.ERROR_NO_TOKEN,
            value: `unable to read token from end of string at ${pos_int}`
        };
    }

    const consume_functions = [
        read_operator,
        read_number,
        read_variable
    ];

    for (let i = 0; i < consume_functions.length; i++) {
        let res = consume_functions[i](s_string, pos_int);
        if (res.type !== TOKEN_TYPE.ERROR_NO_TOKEN)
        {
            return res;
        }
    }

    return {
        type:TOKEN_TYPE.ERROR_NO_TOKEN,
        value: `unable to read token from string at ${pos_int}`
    }
}

function isEmptyOrSpaces(str){
    return str === null || str.match(/^\s*$/) !== null;
}

function tokenize(s_string)
{
    let i = 0;
    let vars_out = [];
    while(i < s_string.length)
    {
        if (isEmptyOrSpaces(s_string.substring(i)))
        {
            break;
        }
        
        let res = read_token(s_string, i);
        if (res.type === TOKEN_TYPE.ERROR_NO_TOKEN)
        {
            return {
                success: false,
                value: res.value
            };
        }
        vars_out.push({
            type: res.type,
            signed : res.value.signed,
            value: res.value.symbol
        });
        i = res.value.new_offset;
    }

    return {
        success: true,
        value: vars_out
    };

}

function assert(b)
{
    if (!b)
    {
        console.log("FAILED CHECK")
        throw EvalError();
    }
}

function make_RPN(symbols)
{
    // copy symbols
    let s = [...symbols];
    s.reverse();

    let output = [];
    let stack = [];
    // console.log(s);
    while (s.length > 0)
    {
        // peek top token
        const token = s.at(-1);

        // if its a number/variable, push it
        if (token.type == TOKEN_TYPE.NUMBER_LITERAL || token.type == TOKEN_TYPE.VARIABLE_NAME)
        {
            output.push(s.pop());
        }
        else if (token.type == TOKEN_TYPE.BRACKET)
        {
            // if it's an open bracket, push it onto the stack
            if (token.value.token == OPERATOR_TOKEN.BRACKET_OPEN)
            {
                stack.push(s.pop());
            }
            else // OPERATOR_TOKEN.BRACKET_CLOSE
            {
                //! TODO better error handling
                assert(token.value.token == OPERATOR_TOKEN.BRACKET_CLOSE);

                // if we're closing a brace, then push all operators between the brace
                while (stack.length > 0 && stack.at(-1).value.token != OPERATOR_TOKEN.BRACKET_OPEN)
                {
                    output.push(stack.pop());
                }

                //! TODO better error handling
                assert(stack.length > 0 && stack.at(-1).value.token == OPERATOR_TOKEN.BRACKET_OPEN);

                // remove the open and close braces
                s.pop();
                stack.pop();
            }
        }
        else if (token.type == TOKEN_TYPE.OPERATOR)
        {
            // we can just assume that r_to_l is better than what's on the stack + r_to_l should be evaluated as the rightmost operator first
            if (token.value.direction == OPERATOR_DIRECTION.R_TO_L)
            {
                stack.push(s.pop());
            }
            else 
            {
                // while there are tokens on the stack that have more precedence or occurred earlier, push them on to the stack
                while (stack.length > 0 && stack.at(-1).type == TOKEN_TYPE.OPERATOR && stack.at(-1).value.precedence <= token.value.precedence)
                {
                    output.push(stack.pop());
                }

                // push our token
                stack.push(s.pop());
            }
        }
        else
        {
            //! TODO better error handling
            assert(false);
        }
    }
    
    // if there are still operators on the stack, push those
    while (stack.length > 0)
    {
        assert(stack.at(-1).type == TOKEN_TYPE.OPERATOR);

        output.push(stack.pop());
    }

    return output;
}

function turn_RPN_into_evaluator(rpn_symbols)
{
    let stack = [];

    for (let i = 0; i < rpn_symbols.length; i++) {
        const element = rpn_symbols[i];
        
        if (element.type == TOKEN_TYPE.VARIABLE_NAME)
        {
            stack.push(new ValueWrapper_VARIABLE(element.value, element.signed));
        }
        else if (element.type == TOKEN_TYPE.NUMBER_LITERAL)
        {
            stack.push(new ValueWrapper_LITERAL(element.value, element.signed));
        }
        else if(element.type == TOKEN_TYPE.OPERATOR)
        {
            if (element.value.arg_num == OPERATOR_ARGS.ARGS_1)
            {
                let v = stack.pop();
                let transformed = new (OPERATOR_TOKEN_TO_VALUEWRAPPER[element.value.token])(v);
                stack.push(transformed);
            }
            else if (element.value.arg_num == OPERATOR_ARGS.ARGS_2)
            {
                let rs = stack.pop();
                let ls = stack.pop();
                let transformed = new (OPERATOR_TOKEN_TO_VALUEWRAPPER[element.value.token])(ls, rs);
                stack.push(transformed);
            }
            else
            {
                //! TODO better error handling
                assert(false);
            }
        }
        else 
        {
            //! TODO better error handling
            assert(false);
        }
    }

    //! TODO better error handling
    assert(stack.length == 1);

    return stack.pop();
}

function make_evaluator(symbols)
{
    sanitize_tokens(symbols);
    let rpn = make_RPN(symbols);
    return turn_RPN_into_evaluator(rpn);
}

function sanitize_tokens(symbols)
{
    // this is mostly to turn negates into their proper symbol
    [[OPERATOR_TOKEN.MATH_SUB, OPERATOR_TOKEN_TO_OPERATOR.MATH_NEGATE], [OPERATOR_TOKEN.MATH_ADD, OPERATOR_TOKEN_TO_OPERATOR.MATH_UNARY]].forEach((tokens) =>{
        let [inp_token, outp_operator] = tokens;
        for(let index = 0; index < symbols.length; index++)
        {
            const element = symbols[index];
            
            if (element.type == TOKEN_TYPE.OPERATOR && element.value.token == inp_token)
            {
                if (index == 0) // first token? gotta negate
                {
                    symbols[index].value = outp_operator;
                }
                else // if we can look back one symbol
                {
                    let prevElem = symbols[index-1];
                    if (prevElem.type == TOKEN_TYPE.OPERATOR || 
                        (prevElem.type == TOKEN_TYPE.BRACKET && prevElem.value.token == OPERATOR_TOKEN.BRACKET_OPEN)
                    ) 
                    {
                        // and that symbol behind us is an operator? negate. "3 + -4", "5 / -(10-2)"
                        // we just opened a bracket, this must be a negate
                        symbols[index].value = outp_operator;
                    }
                }
            }
            
        }
    });
}

function get_all_variable_names(symbols)
{
    let out_names = new Set();
    for (let i = 0; i < symbols.length; i++) {
        const element = symbols[i];
        
        if (element.type == TOKEN_TYPE.VARIABLE_NAME)
        {
            out_names.add(element.value);
        }
    }

    let a = Array.from(out_names);
    a.sort();
    return a;
}

var eq_evaluator;
var variable_names = [];
var eq_variables = [];

function arraysEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (a.length !== b.length) return false;
  
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

function refresh_equation()
{
    eq_evaluator = undefined;

    let v = tokenize(document.getElementById("inp").value);
    if(!v.success) return false;
    variable_names = get_all_variable_names(v.value);
    eq_evaluator = make_evaluator(v.value);
    return true;
}

function evaluate_equation()
{
    function _eval(variable_list, defines_object, out_values)
    {
        if (variable_list.length == 0)
        {
            out_values.push([defines_object, eq_evaluator.getValue(defines_object).value]);
            return;
        }

        let this_variable = variable_list.at(0);
        let [variable_name, min, max] = this_variable;
        let this_spliced_list = variable_list.slice(1);

        if (max === undefined)
        {
            // just do one loop   
            max = min;
        }

        for (let i = min; i <= max; i++)
        {                
            let this_defines_object = new Map(defines_object);
            this_defines_object.set(variable_name, i);
            _eval(this_spliced_list, this_defines_object, out_values);
        }
    }

    let variable_list = eq_variables.map(elem => {
        if (elem.isRange)
        {
            return [elem.name, elem.min, elem.max];
        }
        else
        {
            return [elem.name, elem.min];
        }
    });

    // variable_list = [["uVar4", -10, 10]];

    clearGraph();
    let outValues = [];
    if (variable_list.length == 0)
    {
        variable_list.push(["i", 0])
    }

    _eval(variable_list, new Map(), outValues);

    let has_no_ranges = !variable_list.map((e)=> e.length == 2).includes(false);
    let has_one_variable = false;
    let one_variable_index = -1;
    // if we have some ranges, check if we only have 1 range
    if (!has_no_ranges)
    {
        // if there are variables, we can tell if there is one variable if
        // the first minmax is also the last minmax
        let has_minmax = variable_list.map((e)=> (e.length == 3));
        has_one_variable = has_minmax.indexOf(true) == has_minmax.lastIndexOf(true);
        if (has_one_variable)
        {
            one_variable_index = has_minmax.indexOf(true);
        }
    }
    if (variable_list.length == 1)
    {
        one_variable_index=0;
    }

    if (has_no_ranges || has_one_variable)
    {
        let newValues;
        if (variable_list.length > 0)
        {
            let variable_name = variable_list[one_variable_index][0];
            newValues = outValues.map((e)=>[e[0].get(variable_name), e[1]])
        }
        else 
        {
            newValues = outValues.map((e)=>[e[0].get("i"), e[1]]);
        }
        // console.log(outValues);
        drawGraph(newValues);
    }

    let elem = document.getElementById("allOutputs");
    elem.innerHTML = "";
    outValues.forEach(v => {
        let s = "[";
        s += Array.from(v[0].keys()).map(element => `(${element} : ${formatNumber(v[0].get(element))})`).join(", ");
        s += " = " + formatNumber(v[1]);
        s += "]\n";
        elem.innerHTML += s;
        // JSON.stringify(outValues);
    });
}

function makeVariableIDName(name)
{
    return "variablename_" + name + "_";
}

class VariableRangeSelector {
    constructor(name, min, max, isRange) {
        this.name = name;
        this.min = Number.parseInt(min);
        this.max = Number.parseInt(max);
        this.isRange = isRange;
    }

    setMin(v)
    {
        this.min = Number.parseInt(v);
        evaluate_equation();
    }

    setMax(v)
    {
        this.max = Number.parseInt(v);
        evaluate_equation();
    }

    setValue(v)
    {
        this.min = Number.parseInt(v);
        evaluate_equation();
    }

    becomeRange()
    {
        this.isRange = true;
        evaluate_equation();
    }

    becomeSingle()
    {
        this.isRange = false;
        evaluate_equation();
    }
}

function createVariableRangeOption(rangeObj) 
{
    const container = document.createElement('div');
    container.className = "container";

    let minLabel = document.createElement("label");
    if (rangeObj.isRange)
    {
        minLabel.textContent = "Min";
    }
    else
    {
        minLabel.textContent = "Value";
    }

    let minField = document.createElement("input");
    minField.id = makeVariableIDName(rangeObj.name) + "min";
    minField.type = "text"
    minField.addEventListener('input', () => rangeObj.setMin(minField.value));
    
    let maxLabel = document.createElement("label");
    maxLabel.textContent = "Max";
    let maxField = document.createElement("input");
    maxField.id = makeVariableIDName(rangeObj.name) + "max";
    maxField.type = "text"
    maxField.addEventListener('input', () => rangeObj.setMax(maxField.value));

    let nameLabel = document.createElement("label");
    nameLabel.textContent = rangeObj.name;
    nameLabel.className = "variableName";
    container.appendChild(nameLabel);

    {
        let input = document.createElement('input');
        input.type = 'radio';
        input.className = rangeObj.name + '-question-option';
        input.value = "Single";
        input.id = makeVariableIDName(rangeObj.name) + "Single";

        input.addEventListener("change", ()=>{
            maxLabel.style.display = "none";
            maxField.style.display = "none";
            minLabel.textContent = "Value";
            rangeObj.becomeSingle();
        });

        input.checked = !rangeObj.isRange;
        input.name = rangeObj.name + '-question-option'; // who else belongs to this group

        let label = document.createElement('label');
        label.for = makeVariableIDName(rangeObj.name) + "Single";
        label.textContent = "Single";
        label.className = "Range-Single-option";
        
        container.appendChild(input);
        container.appendChild(label);
    }

    {
        let input = document.createElement('input');
        input.type = 'radio';
        input.className = rangeObj.name + '-question-option';
        input.value = "Range";
        input.id = makeVariableIDName(rangeObj.name) + "Range";
        input.addEventListener("change", ()=>{
            maxLabel.style.display = "inline";
            maxField.style.display = "inline";
            minLabel.textContent = "Min";
            rangeObj.becomeRange();
        });
        input.checked = rangeObj.isRange;
        input.name = rangeObj.name + '-question-option'; // who else belongs to this group

        let label = document.createElement('label');
        label.for = makeVariableIDName(rangeObj.name) + + "Range";
        label.textContent = "Range";
        label.className = "Range-Single-option";
        
        container.appendChild(input);
        container.appendChild(label);
    }

    minField.value = rangeObj.min;
    maxField.value = rangeObj.max;
    if (!rangeObj.isRange)
    {
        maxLabel.style.display = "none";
        maxField.style.display = "none";
    }

    container.appendChild(minLabel);
    container.appendChild(minField);
    container.appendChild(maxLabel);
    container.appendChild(maxField);

    return container;
};

function makeVariableButtons()
{
    let toAdd = [];
    let toDelete = [];

    eq_variables.forEach((element, i) => {
        if (!variable_names.includes(element.name))
        {
            toDelete.push(element.name);
        }
    });

    variable_names.forEach(element => {
        if (!eq_variables.find((elem) => (elem.name == element)))
        {
            toAdd.push(element);
        }
    });
    
    toDelete.forEach(toDel => {
        eq_variables.splice(eq_variables.findIndex((elem) => (elem.name == toDel)));
    });

    toAdd.forEach(element => {
        let shouldBeRange = eq_variables.length == 0;
        eq_variables.push(new VariableRangeSelector(element, shouldBeRange ? -10 : 0, shouldBeRange ? 10 : 0, shouldBeRange));
    });

    clearVariableNames();
    let inps = document.getElementById("inputFields");
    eq_variables.forEach((n) => {
        inps.appendChild(createVariableRangeOption(n))
    });
}

function clearGraph()
{
    let ctx = graphCanvas.getContext('2d');
    ctx.clearRect(0, 0, graphCanvas.width, graphCanvas.height);
    dots = [];
}

function clearVariableNames()
{
    let inps = document.getElementById("inputFields");
    inps.innerHTML = "";
}

function clearOutputList()
{
    let elem = document.getElementById("allOutputs");
    elem.innerHTML = "";
}

function drawGraph(v)
{
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    v.forEach(element => {
        let [x, y] = element;
        if (Number.isFinite(x))
        {
            minx = Math.min(minx, x);
            maxx = Math.max(maxx, x);
        }
        if (Number.isFinite(y))
        {
            miny = Math.min(miny, y);
            maxy = Math.max(maxy, y);
        }
    });

    let border_size = 0.05;

    let border_bl =  [graphCanvas.width * border_size, graphCanvas.height * (1 - border_size)];
    let border_br =  [graphCanvas.width * (1 - border_size), graphCanvas.height * (1 - border_size)];
    let border_tl =  [graphCanvas.width * border_size, graphCanvas.height * border_size];
    let border_tr =  [graphCanvas.width * (1 - border_size), graphCanvas.height * border_size];

    let ctx = graphCanvas.getContext('2d');

    function get_point(xy)
    {
        const [x,y] = xy;

        const c_w = graphCanvas.width * (1 - (2 * border_size));
        const c_h = graphCanvas.height * (1 - (2 * border_size));

        let _minX = minx - 1;
        let _maxX = maxx + 1;
        let _minY = miny - 1;
        let _maxY = maxy + 1;

        const g_w = _maxX-_minX;
        const g_h = _maxY-_minY;

        const out_x = border_bl[0] + ((x - _minX) / g_w) * c_w;
        const out_y = border_bl[1] - ((y - _minY) / g_h) * c_h;

        return [out_x, out_y];
    }

    let radius = 5;
    function plot_point(xy)
    {
        const [x, y] = get_point(xy);
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI, false);
        ctx.fillStyle = 'green';
        ctx.fill();
        // ctx.lineWidth = 5;
        ctx.strokeStyle = '#003300';
        ctx.stroke();
    }

    function draw_axis(startPoint, endPoint)
    {
        ctx.beginPath();
        ctx.strokeStyle = '#000000';
        ctx.moveTo(...startPoint);
        ctx.lineTo(...endPoint);
        ctx.stroke();
    }

    function draw_axes()
    {
        let zero_p = get_point([0, 0]);
        
        // attempt to draw the vertical line
        // if we can include 0, in our vertical line, draw from top to bottom
        if (minx <= 0 && 0 <= maxx)
        {
            draw_axis([zero_p[0], border_tl[1]], [zero_p[0], border_bl[1]]);
        }
        // if we can't draw a big vertical slice, we can draw a boxed in side on the left
        else if (minx > 0)
        {
            draw_axis(border_tl, border_bl);
        }
        // if we can't draw a big vertical slice, we can draw a boxed in side on the right
        else if(maxx < 0)
        {
            draw_axis(border_tr, border_br);
        }

        // attempt to draw the horizontal line
        // if we can include 0, in our vertical line, draw from top to bottom
        if (miny <= 0 && 0 <= maxy)
        {
            draw_axis([border_bl[0], zero_p[1]], [border_br[0], zero_p[1]]);
        }
        // if we can't draw a big horizontal slice, we can draw a boxed in side on the bottom
        else if (miny > 0)
        {
            draw_axis(border_bl, border_br);
        }
        // if we can't draw a big horizontal slice, we can draw a boxed in side on the top
        else if(maxy < 0)
        {
            draw_axis(border_tl, border_tr);
        }
    }

    ctx.clearRect(0, 0, graphCanvas.width, graphCanvas.height);
    
    ctx.strokeStyle = "#000000";
    ctx.fillStyle = "#F0F0FFFF";
    ctx.fillRect(0, 0, graphCanvas.width, graphCanvas.height);

    // Set line width
    ctx.lineWidth = 1;
    draw_axes();

    ctx.beginPath()

    ctx.setLineDash([5, 15]);
    v.forEach(element => {
        if (Number.isFinite(element[1]))
        {
            // if we have a valid point, add it to the path
            ctx.lineTo(...get_point(element));
        }
        else
        {
            // otherwise finish the path, and start a new one (skipping this point which is infinity or nan)
            ctx.stroke();
            ctx.beginPath()
        }
        // plot_point(element);
    });
    ctx.stroke();
    ctx.setLineDash([0, 0]);

    v.forEach(element => {
        plot_point(element);
    });

    // draw text for minx, maxx, ...
    // Y Values
    // draw on the left side, unless maxx <=0
    let font_size = 15;
    ctx.font = font_size + "px Arial";
    ctx.strokeStyle = "#000000FF";
    ctx.fillStyle = "#000000FF";
    let y_x_side;
    if (maxx > 0)
    {
        y_x_side = 0;
    }
    else
    {
        y_x_side = border_br[0];
    }
    ctx.fillText(formatNumber(miny), y_x_side, get_point([0, miny])[1] + (font_size/2));
    ctx.fillText(formatNumber(maxy), y_x_side, get_point([0, maxy])[1] + (font_size/2));

    if (miny != maxy && miny < 0 && maxy > 0)
    {
        ctx.fillText(formatNumber(0), y_x_side, get_point([0, 0])[1] + (font_size/2));
    }

    // X Values
    // draw on the Bottom side, unless maxx <=0
    let x_y_side;
    if ((maxy == miny && maxy == 0) || maxy > 0)
    {
        x_y_side = graphCanvas.height;
    }
    else
    {
        x_y_side = font_size;
    }
    ctx.fillText(formatNumber(minx), get_point([minx, 0])[0], x_y_side);
    ctx.fillText(formatNumber(maxx), get_point([maxx, 0])[0], x_y_side);

    if (minx != maxx && minx < 0 && maxx > 0)
    {
        ctx.fillText(formatNumber(0), get_point([0, 0])[0], x_y_side);
    }

    v.forEach(p => {
        let canvas_p = get_point(p);
        dots.push({
            x: canvas_p[0],
            y: canvas_p[1],
            r: radius,
            rXr:radius*radius,
            tip: `(${formatNumber(p[0])}, ${formatNumber(p[1])})`
        })
    });
}

var graphCanvas;

function GetURLParameter()
{
    let url = new URL(window.location);
    return url.searchParams.get("seq");
}

function equationChanged()
{
    document.getElementById("copyBtn_confirm").innerHTML = "";
    clearGraph();
    clearVariableNames();
    clearOutputList();
    if (!refresh_equation()) return;
    makeVariableButtons();
    evaluate_equation();
}

var dots = [];

document.addEventListener('DOMContentLoaded', function (event) {
    let inputElement = document.getElementById("inp");
    graphCanvas = document.getElementById("graphOutput");
    inputElement.addEventListener("input", equationChanged);
    document.getElementById("HexCheck").addEventListener("input", equationChanged);

    document.getElementById("copyBtn").addEventListener("click", ()=>{
        let url = new URL([location.protocol, '//', location.host, location.pathname].join(""));
        url.searchParams.append("seq", inputElement.value);
        // console.log(url);
        navigator.clipboard.writeText(url);
        document.getElementById("copyBtn_confirm").innerHTML = "copied!"
    });

    let graphTT = document.getElementById("graphToolTip");
    let tipCtx = graphTT.getContext('2d');
    let font_size = 12;
    tipCtx.font = font_size + "px Arial";
    graphCanvas.addEventListener("mousemove", (e) => {
        let = offsetX = graphCanvas.offsetLeft;
        let = offsetY = graphCanvas.offsetTop;
        mouseX=parseInt(e.pageX-offsetX);
        mouseY=parseInt(e.pageY-offsetY);


        let closestDistance = null;
        for (var i = 0; i < dots.length; i++) {
            let dot = dots[i];
            let dx = mouseX - dot.x;
            let dy = mouseY - dot.y;
            let dist = dx * dx + dy * dy;
            if (dist < dot.rXr && ((closestDistance === null) || (dist < closestDistance))) {
                graphTT.style.left = e.pageX + "px";
                graphTT.style.top = (e.pageY - 40) + "px";
                tipCtx.clearRect(0, 0, graphTT.width, graphTT.height);
                tipCtx.fillText(dot.tip, 5, 15);
                closestDistance = dist;
            }
        }
        if (closestDistance === null) { graphTT.style.left = "-200px"; }
    });

    let urlParams = GetURLParameter("seq");
    if (urlParams !== null)
    {
        inputElement.defaultValue = urlParams;
        equationChanged();
    }
    else if (inputElement.innerHTML == "")
    {
        inputElement.defaultValue = Value='(uVar4 & 1 ^ uVar4 >> 0x1f) != uVar4 >> 0x1f';
        equationChanged();
    }
})