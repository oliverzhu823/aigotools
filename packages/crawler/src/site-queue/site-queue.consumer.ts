import { OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import axios, { AxiosError } from 'axios';
import { Job } from 'bull';
import * as _ from 'lodash';
import { Model } from 'mongoose';
import OpenAI from 'openai';
import * as sharp from 'sharp';
import { PromptOutput, SiteSummaryPrompt } from '../prompts/site-summary';
import { BrowserService } from '../providers/browser.service';
import { S3Service } from '../providers/s3.service';
import { ProcessStage, Site, SiteDocument } from '../schemas/site.schema';
import { SITE_CRAWL_JOB, SITE_QUEUE_NAME } from './site-queue.constant';
import { Category } from '../schemas/category.schema';
import { RedisService } from '../providers/redis.service';

@Processor(SITE_QUEUE_NAME)
export class SiteConsumer {
  constructor(
    @InjectModel(Site.name) private siteModel: Model<Site>,
    @InjectModel(Category.name) private categoryModel: Model<Category>,

    private browserService: BrowserService,
    private s3Service: S3Service,
    private configService: ConfigService,
    private redisService: RedisService,
  ) {}

  private async getUrlScreenshot(url: string) {
    const cacheKey = `aogotools:${encodeURIComponent(url)}:screenshopt`;
    const cache = await this.redisService.redisClient.get(cacheKey);
    if (cache) {
      try {
        return JSON.parse(cache) as {
          snapshot: string;
          keywords: string[];
          desceription: string;
        };
      } catch (error) {
        Logger.error(`Parse screenshopt cache error: ${error}`);
      }
    }
    const {
      keywords,
      desceription,
      screenshot: imageBuffer,
    } = await this.browserService.screenshot(url);

    const resizedSnapshot = await sharp(imageBuffer)
      .toFormat('webp')
      .resize(800, 450, { position: 'top' })
      .toBuffer();

    const snapshot = await this.s3Service.uploadBufferToS3(
      resizedSnapshot,
      'image/webp',
    );
    Logger.log(`screenshopt ${url} success: ${snapshot}`);
    await this.redisService.redisClient.setex(
      cacheKey,
      600,
      JSON.stringify({ keywords, desceription, snapshot }),
    );

    return {
      snapshot,
      keywords,
      desceription,
    };
  }

  private async getUrlContent(url: string) {
    const cacheKey = `aogotools:${encodeURIComponent(url)}:content`;
    const cache = await this.redisService.redisClient.get(cacheKey);
    if (cache) {
      return cache;
    }
    const jinaBase = this.configService.get(
      'JINA_READ_BASE',
      'https://r.jina.ai',
    );
    const jinaApiKey = this.configService.get('JINA_API_KEY');
    const jinaCommonHeaders = { Accept: 'application/json' };
    if (jinaApiKey) {
      jinaCommonHeaders['Authorization'] = `Bearer ${jinaApiKey}`;
    }

    const siteContentRes = await axios.get<{
      code: number;
      status: number;
      data: { title: string; url: string; content: string };
    }>(`${jinaBase}/${url}`, {
      headers: {
        ...jinaCommonHeaders,
        'X-Return-Format': 'markdown',
      },
    });
    if (
      siteContentRes.data.status !== 20000 ||
      siteContentRes.data.code !== 200
    ) {
      throw new Error(
        `Wrong jina read response status: ${siteContentRes.data.status} ${siteContentRes.data.code}`,
      );
    }
    Logger.log(`get ${url} content success`);
    const content = siteContentRes.data.data.content;
    await this.redisService.redisClient.setex(cacheKey, 600, content);
    return content;
  }

  private async summarySiteContent(site: Site) {
    // ai summary
    const content = await this.getUrlContent(site.url);
    const imageRegex = /!\[.*?\]\((.*?)\)/g;

    const images = [];
    let match;
    while ((match = imageRegex.exec(content)) !== null) {
      images.push(match[1]);
    }
    const cleanedMarkdown = content.replace(imageRegex, '');

    const openai = new OpenAI({
      baseURL: this.configService.get('OPENAI_BASEURL'),
      apiKey: this.configService.get('OPENAI_KEY'),
    });
    const response = await openai.chat.completions.create({
      model: this.configService.get('OPENAI_MODEL'),
      messages: [
        { role: 'system', content: SiteSummaryPrompt },
        { role: 'user', content: cleanedMarkdown },
      ],
      temperature: 1,
      stream: false,
    });
    const cleanedContent = response.choices[0].message.content
      .replace(/(^```(json)?|```$)/g, '')
      .trim();

    let summaried;
    try {
      summaried = JSON.parse(cleanedContent) as PromptOutput;
    } catch (error) {
      Logger.error(`parse output content error:\n${cleanedContent}`);
      throw error;
    }

    Logger.log(`summary ${site.url} success`);

    return summaried;
  }

  @Process({
    name: SITE_CRAWL_JOB,
    concurrency: 10,
  })
  async crawlSite(job: Job<string>) {
    const siteId = job.data;
    Logger.log(`process site ${siteId} start`);

    let site: SiteDocument;

    try {
      site = await this.siteModel.findById(siteId);
      if (!site) {
        throw new Error('Site not found');
      }
      site.url = new URL(site.url).origin;
      Logger.log(`site ${siteId} url: ${site.url}`);

      // const { keywords, desceription, snapshot } = await this.getUrlScreenshot(
      //   site.url,
      // );

      // const summaried = await this.summarySiteContent(site);

      const [{ keywords, desceription, snapshot }, summaried] =
        await Promise.all([
          this.getUrlScreenshot(site.url),
          this.summarySiteContent(site),
        ]);

      // transform category to id
      let categoriesIds = [] as string[];
      const summariedCatrgories = _.get(summaried, 'categories', []);
      if (summariedCatrgories.length) {
        const existedCategories = await this.categoryModel.find({
          name: { $in: summariedCatrgories },
        });
        const newCategoryNames = _.difference(
          summariedCatrgories,
          _.map(existedCategories, 'name'),
        );
        const newCategories = await this.categoryModel.insertMany(
          newCategoryNames.map((name) => {
            return {
              icon: '',
              name,
            };
          }),
        );
        categoriesIds.push(
          ..._.map(existedCategories, '_id'),
          ..._.map(newCategories, '_id'),
        );
      } else {
        categoriesIds = site.categories;
      }

      site.snapshot = snapshot;
      site.processStage = ProcessStage.success;
      site.name = _.get(summaried, 'name', site.name);
      site.desceription = _.get(summaried, 'introduction', site.desceription);
      site.users = _.get(summaried, 'users', site.users);
      site.features = _.get(summaried, 'features', site.features);
      site.categories = categoriesIds;
      site.usecases = _.get(summaried, 'usecases', site.usecases);
      site.pricingType = _.get(summaried, 'pricingType', site.pricingType);
      site.pricings = _.get(summaried, 'pricings', site.pricings);
      site.links = _.get(summaried, 'links', site.links);
      site.metaKeywords = keywords.length
        ? keywords
        : _.get(summaried, 'keywords', site.metaKeywords);
      site.metaDescription = desceription;
      site.searchSuggestWords = _.get(
        summaried,
        'searchSuggestWords',
        site.searchSuggestWords,
      );
    } catch (error) {
      if (error instanceof AxiosError) {
        Logger.error(
          `process site ${siteId} error`,
          error.response.config.url,
          error,
        );
      } else {
        Logger.error(`process site ${siteId} error`, error);
      }
      throw error;
    } finally {
      if (site) {
        site.updatedAt = Date.now();
        await site?.save();
      }
    }
  }

  @OnQueueFailed({ name: SITE_CRAWL_JOB })
  async handleSunoDispatchLyricJobFailed(job: Job<string>) {
    if (
      job.attemptsMade &&
      job.opts.attempts &&
      job.attemptsMade < job.opts.attempts
    ) {
      return;
    }
    const siteId = job.data;
    Logger.error(
      `${SITE_CRAWL_JOB} for ${siteId} failed after ${job.attemptsMade} attempts`,
    );
    await this.siteModel.findByIdAndUpdate(siteId, {
      $set: {
        updatedAt: Date.now(),
        processStage: ProcessStage.fail,
      },
    });
  }
}