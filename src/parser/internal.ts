import {
  DividerBlock,
  HeaderBlock,
  ImageBlock,
  KnownBlock,
  RichTextBlock,
  RichTextElement,
  RichTextList,
  RichTextSection,
  SectionBlock,
  TableBlock,
} from '@slack/types';
import {ListOptions, ParsingOptions} from '../types';
import {section, divider, header, image, table} from '../slack';
import {marked} from 'marked';
import {XMLParser} from 'fast-xml-parser';

type PhrasingToken =
  | marked.Tokens.Link
  | marked.Tokens.Em
  | marked.Tokens.Strong
  | marked.Tokens.Del
  | marked.Tokens.Br
  | marked.Tokens.Image
  | marked.Tokens.Codespan
  | marked.Tokens.Text
  | marked.Tokens.HTML;

function parsePlainText(element: PhrasingToken): string[] {
  switch (element.type) {
    case 'link':
    case 'em':
    case 'strong':
    case 'del':
      return element.tokens.flatMap(child =>
        parsePlainText(child as PhrasingToken)
      );

    case 'br':
      return [];

    case 'image':
      return [element.title ?? element.href];

    case 'codespan':
    case 'text':
    case 'html':
      return [element.raw];
  }
}

function isSectionBlock(block: KnownBlock): block is SectionBlock {
  return block.type === 'section';
}

function parseMrkdwn(
  element: Exclude<PhrasingToken, marked.Tokens.Image>
): string {
  switch (element.type) {
    case 'link': {
      return `<${element.href}|${element.tokens
        .flatMap(child => parseMrkdwn(child as typeof element))
        .join('')}> `;
    }

    case 'em': {
      return `_${element.tokens
        .flatMap(child => parseMrkdwn(child as typeof element))
        .join('')}_`;
    }

    case 'codespan':
      return `\`${element.text}\``;

    case 'strong': {
      return `*${element.tokens
        .flatMap(child => parseMrkdwn(child as typeof element))
        .join('')}*`;
    }

    case 'text':
      return element.text;

    case 'del': {
      return `~${element.tokens
        .flatMap(child => parseMrkdwn(child as typeof element))
        .join('')}~`;
    }

    default:
      return '';
  }
}

function addMrkdwn(
  content: string,
  accumulator: (SectionBlock | ImageBlock)[]
) {
  const last = accumulator[accumulator.length - 1];

  if (last && isSectionBlock(last) && last.text) {
    last.text.text += content;
  } else {
    accumulator.push(section(content));
  }
}

function parsePhrasingContentToStrings(
  element: PhrasingToken,
  accumulator: string[]
) {
  if (element.type === 'image') {
    accumulator.push(element.href ?? element.title ?? element.text ?? 'image');
  } else {
    const text = parseMrkdwn(element);
    accumulator.push(text);
  }
}

function parsePhrasingContent(
  element: PhrasingToken,
  accumulator: (SectionBlock | ImageBlock)[]
) {
  if (element.type === 'image') {
    const imageBlock: ImageBlock = image(
      element.href,
      element.text || element.title || element.href,
      element.title
    );
    accumulator.push(imageBlock);
  } else {
    const text = parseMrkdwn(element);
    addMrkdwn(text, accumulator);
  }
}

function parseParagraph(element: marked.Tokens.Paragraph): KnownBlock[] {
  return element.tokens.reduce((accumulator, child) => {
    parsePhrasingContent(child as PhrasingToken, accumulator);
    return accumulator;
  }, [] as (SectionBlock | ImageBlock)[]);
}

function parseHeading(element: marked.Tokens.Heading): HeaderBlock {
  return header(
    element.tokens
      .flatMap(child => parsePlainText(child as PhrasingToken))
      .join('')
  );
}

function parseCode(element: marked.Tokens.Code): SectionBlock {
  return section(`\`\`\`\n${element.text}\n\`\`\``);
}

type RichTextStyle = {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
};

function parseRichTextElements(
  element: PhrasingToken,
  inheritedStyle: RichTextStyle = {}
): RichTextElement[] {
  switch (element.type) {
    case 'strong':
      return element.tokens.flatMap(child =>
        parseRichTextElements(child as PhrasingToken, {
          ...inheritedStyle,
          bold: true,
        })
      );

    case 'em':
      return element.tokens.flatMap(child =>
        parseRichTextElements(child as PhrasingToken, {
          ...inheritedStyle,
          italic: true,
        })
      );

    case 'del':
      return element.tokens.flatMap(child =>
        parseRichTextElements(child as PhrasingToken, {
          ...inheritedStyle,
          strike: true,
        })
      );

    case 'codespan': {
      const style = {...inheritedStyle, code: true};
      return [{type: 'text', text: element.text, style}];
    }

    case 'link': {
      const linkText = element.tokens
        .flatMap(child => parsePlainText(child as PhrasingToken))
        .join('');
      const hasStyle = Object.keys(inheritedStyle).length > 0;
      return [
        {
          type: 'link',
          url: element.href,
          text: linkText,
          ...(hasStyle && {style: inheritedStyle}),
        } as RichTextElement,
      ];
    }

    case 'text': {
      const hasStyle = Object.keys(inheritedStyle).length > 0;
      return [
        {
          type: 'text',
          text: element.text,
          ...(hasStyle && {style: inheritedStyle}),
        },
      ];
    }

    case 'br':
      return [{type: 'text', text: '\n'}];

    case 'image':
      return [{type: 'text', text: element.title ?? element.href}];

    case 'html':
      return [{type: 'text', text: element.raw}];

    default:
      return [];
  }
}

function parseListItemRichText(
  item: marked.Tokens.ListItem
): RichTextSection {
  const paragraph = item.tokens[0] as marked.Tokens.Text;
  let elements: RichTextElement[] = [];

  if (paragraph && paragraph.type === 'text' && paragraph.tokens?.length) {
    elements = paragraph.tokens.flatMap(child =>
      parseRichTextElements(child as PhrasingToken)
    );
  } else if (paragraph) {
    elements = [{type: 'text', text: paragraph.text || ''}];
  }

  return {type: 'rich_text_section', elements};
}

function flattenListToRuns(
  element: marked.Tokens.List,
  depth: number = 0
): {style: 'bullet' | 'ordered'; indent: number; section: RichTextSection}[] {
  const runs: {
    style: 'bullet' | 'ordered';
    indent: number;
    section: RichTextSection;
  }[] = [];
  const style = element.ordered ? 'ordered' : 'bullet';

  for (const item of element.items) {
    runs.push({style, indent: depth, section: parseListItemRichText(item)});

    // Process nested lists within this item
    for (let i = 1; i < item.tokens.length; i++) {
      const token = item.tokens[i];
      if (token.type === 'list') {
        runs.push(
          ...flattenListToRuns(token as marked.Tokens.List, depth + 1)
        );
      }
    }
  }

  return runs;
}

function parseList(element: marked.Tokens.List): RichTextBlock {
  const runs = flattenListToRuns(element);

  // Group consecutive runs with the same style and indent into rich_text_list elements
  const listElements: RichTextList[] = [];
  for (const run of runs) {
    const last = listElements[listElements.length - 1];
    if (last && last.style === run.style && (last.indent ?? 0) === run.indent) {
      last.elements.push(run.section);
    } else {
      const listEl: RichTextList = {
        type: 'rich_text_list',
        style: run.style,
        elements: [run.section],
      };
      if (run.indent > 0) {
        listEl.indent = run.indent;
      }
      listElements.push(listEl);
    }
  }

  return {type: 'rich_text', elements: listElements};
}

function parseTableCell(
  cell: marked.Tokens.TableCell
): {type: 'raw_text'; text: string} {
  const texts = cell.tokens.reduce((accumulator, child) => {
    parsePhrasingContentToStrings(child as PhrasingToken, accumulator);
    return accumulator;
  }, [] as string[]);
  return {type: 'raw_text', text: texts.join(' ')};
}

function parseTableRow(
  row: marked.Tokens.TableCell[]
): {type: 'raw_text'; text: string}[] {
  return row.map(cell => parseTableCell(cell));
}

function parseTable(element: marked.Tokens.Table): TableBlock {
  const alignMap: Record<string, 'left' | 'center' | 'right'> = {
    left: 'left',
    center: 'center',
    right: 'right',
  };
  const columnSettings = element.align.map(a => ({
    align: (a && alignMap[a]) || 'left',
  }));

  const rows = [element.header, ...element.rows].map(row =>
    parseTableRow(row)
  );

  return table(rows, columnSettings);
}

function parseBlockquote(element: marked.Tokens.Blockquote): KnownBlock[] {
  return element.tokens
    .filter(
      (child): child is marked.Tokens.Paragraph => child.type === 'paragraph'
    )
    .flatMap(p =>
      parseParagraph(p).map(block => {
        if (isSectionBlock(block) && block.text?.text?.includes('\n'))
          block.text.text = '> ' + block.text.text.replace(/\n/g, '\n> ');
        return block;
      })
    );
}

function parseThematicBreak(): DividerBlock {
  return divider();
}

function parseHTML(
  element: marked.Tokens.HTML | marked.Tokens.Tag
): KnownBlock[] {
  const parser = new XMLParser({ignoreAttributes: false});
  const res = parser.parse(element.raw);

  if (res.img) {
    const tags = res.img instanceof Array ? res.img : [res.img];

    return tags
      .map((img: Record<string, string>) => {
        const url: string = img['@_src'];
        return image(url, img['@_alt'] || url);
      })
      .filter((e: Record<string, string>) => !!e);
  } else return [];
}

function parseToken(
  token: marked.Token,
  options: ParsingOptions
): KnownBlock[] {
  switch (token.type) {
    case 'heading':
      return [parseHeading(token)];

    case 'paragraph':
      return parseParagraph(token);

    case 'code':
      return [parseCode(token)];

    case 'blockquote':
      return parseBlockquote(token);

    case 'list':
      return [parseList(token)];

    case 'table':
      return [parseTable(token)];

    case 'hr':
      return [parseThematicBreak()];

    case 'html':
      return parseHTML(token);

    default:
      return [];
  }
}

export function parseBlocks(
  tokens: marked.TokensList,
  options: ParsingOptions = {}
): KnownBlock[] {
  return tokens.flatMap(token => parseToken(token, options));
}
